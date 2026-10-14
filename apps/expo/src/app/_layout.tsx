import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { showToastable } from "react-native-toastable";
import Constants from "expo-constants";
import * as Device from "expo-device";
import {
  Stack,
  useNavigationContainerRef,
  usePathname,
  useRootNavigationState,
  useRouter,
  useSegments,
} from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import * as SplashScreen from "expo-splash-screen";
import { AtpAgent, type AtpSessionData } from "@atproto/api";
import { ActionSheetProvider } from "@expo/react-native-action-sheet";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { ThemeProvider } from "@react-navigation/native";
import * as Sentry from "@sentry/react-native";
import { useQueryClient } from "@tanstack/react-query";

import { ListProvider } from "~/components/lists/context";
import { StatusBar } from "~/components/status-bar";
import { type SavedSession } from "~/components/switch-accounts";
import { Toastable } from "~/components/toastable/toastable";
import I18nProvider, { initializeI18n } from "~/i18n/config";
import {
  AgentProvider,
  AuthProvider,
  defaultAgent,
  type AuthContextValue,
} from "~/lib/agent";
import { createAtprotoAgent, defaultPdsUrl } from "~/lib/atproto-urls";
import { callerHint, logFlow } from "~/lib/flow-log";
import { PreferencesProvider } from "~/lib/hooks/preferences";
import { CustomerInfoProvider, useConfigurePurchases } from "~/lib/purchases";
import { useQuickAction, useSetupQuickActions } from "~/lib/quick-actions";
import { useThemeSetup } from "~/lib/storage/app-preferences";
import { store } from "~/lib/storage/storage";
import { TRPCProvider } from "~/lib/utils/api";
import { resolvePdsFromDid, resolvePdsUrl } from "~/lib/utils/resolve-pds";
import { isIOS26 } from "~/lib/utils/version";
import { WalletProvider } from "~/lib/web3/custody";

const routingInstrumentation = Sentry.reactNavigationIntegration();
const sentryDsn = Constants.expoConfig?.extra?.sentry as string | undefined;

Sentry.init({
  enabled: !__DEV__ && Boolean(sentryDsn),
  debug: false,
  dsn: sentryDsn,
});

const useSentryTracing = () => {
  const ref = useNavigationContainerRef();

  useEffect(() => {
    if (ref) {
      routingInstrumentation.registerNavigationContainer(ref);
    }
  }, [ref]);
};

void SplashScreen.preventAutoHideAsync();

initializeI18n();

// Seeing this mid-flow means the whole JS context reloaded (not a navigation
// reset); module-level state like the wallet toast store is wiped with it.
logFlow("nav", "JS bundle evaluated", { at: new Date().toISOString() });

const App = () => {
  const segments = useSegments();
  const pathname = usePathname();
  const rootNavigationState = useRootNavigationState();
  const router = useRouter();
  const queryClient = useQueryClient();
  const walletLockRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [startupDestination, setStartupDestination] = useState<
    "/feeds" | "/" | null
  >(null);
  const [agent, setAgent] = useState<AtpAgent | null>(null);
  const theme = useThemeSetup();
  const { _ } = useLingui();
  const tRef = useRef(_);
  tRef.current = _;
  const routerRef = useRef(router);
  routerRef.current = router;
  const resumingRef = useRef(false);
  const requestedStartupDestinationRef = useRef<"/feeds" | "/" | null>(null);

  // Save session to storage and update saved sessions list
  const saveSessionToStorage = useCallback(
    (sess: AtpSessionData, pdsUrl: string, currentAgent: AtpAgent) => {
      const storedSession: StoredSession = { session: sess, pdsUrl };
      store.set("session", JSON.stringify(storedSession));
      // Update saved sessions list with profile info
      void currentAgent.getProfile({ actor: sess.did }).then((res) => {
        if (res.success) {
          const sessions = store.getString("sessions");
          const newSession: SavedSession = {
            session: sess,
            did: sess.did,
            handle: res.data.handle,
            avatar: res.data.avatar,
            displayName: res.data.displayName,
            pdsUrl,
            signedOut: false,
          };
          if (sessions) {
            const old = JSON.parse(sessions) as SavedSession[];
            const newSessions = [
              newSession,
              ...old.filter((s) => s.did !== sess.did),
            ];
            store.set("sessions", JSON.stringify(newSessions));
          } else {
            store.set("sessions", JSON.stringify([newSession]));
          }
        }
      });
    },
    [],
  );

  // Helper to handle session expiry
  const handleSessionExpired = useCallback(() => {
    logFlow("auth", "handleSessionExpired", { caller: callerHint() });
    store.remove("session");
    walletLockRef.current();
    showToastable({
      message: tRef.current(
        msg`Sorry! Your session expired. Please log in again.`,
      ),
    });
    setAgent(null);
    // Dismiss any modals and go to landing
    if (routerRef.current.canDismiss()) {
      routerRef.current.dismissAll();
    }
    routerRef.current.replace("/");
  }, []);

  const createAgentForPds = useCallback(
    (pdsUrl: string) => {
      const newAgent = createAtprotoAgent({
        service: pdsUrl,
        fetch: async (input, init) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          logFlow("auth", "PDS request", {
            method: init?.method ?? "GET",
            url,
          });
          try {
            const response = await fetch(input, init);
            logFlow("auth", "PDS response", {
              status: response.status,
              url,
            });
            return response;
          } catch (error) {
            logFlow("auth", "PDS request failed", {
              message: error instanceof Error ? error.message : String(error),
              url,
            });
            throw error;
          }
        },
        persistSession(evt, sess) {
          if (evt === "create" || evt === "update") {
            if (sess) {
              saveSessionToStorage(sess, pdsUrl, newAgent);
            }
          } else if (evt === "expired") {
            handleSessionExpired();
          }
        },
      });
      return newAgent;
    },
    [saveSessionToStorage, handleSessionExpired],
  );

  // Auth functions
  const login = useCallback(
    async (identifier: string, password: string, authFactorToken?: string) => {
      // Resolve the PDS URL from the handle
      const pdsUrl = await resolvePdsUrl(identifier);
      const newAgent = createAgentForPds(pdsUrl);
      await newAgent.login({ identifier, password, authFactorToken });
      setAgent(newAgent);
    },
    [createAgentForPds],
  );

  const resumeSession = useCallback(
    async (session: AtpSessionData, pdsUrl?: string) => {
      // Use provided PDS URL or resolve from DID as fallback
      const resolvedPdsUrl = pdsUrl ?? (await resolvePdsFromDid(session.did));
      const newAgent = createAgentForPds(resolvedPdsUrl);
      await newAgent.resumeSession(session);
      setAgent(newAgent);
    },
    [createAgentForPds],
  );

  const logout = useCallback(() => {
    logFlow("auth", "logout", { caller: callerHint() });
    // Mark current session as signed out in saved sessions
    const currentDid = agent?.session?.did;
    if (currentDid) {
      const sessions = store.getString("sessions");
      if (sessions) {
        const old = JSON.parse(sessions) as SavedSession[];
        const newSessions = old.map((s) =>
          s.did === currentDid ? { ...s, signedOut: true } : s,
        );
        store.set("sessions", JSON.stringify(newSessions));
      }
    }
    store.remove("session");
    queryClient.clear();
    walletLockRef.current();
    setAgent(null);
    // Dismiss any modals and go to landing
    if (router.canDismiss()) {
      router.dismissAll();
    }
    router.replace("/");
  }, [agent?.session?.did, queryClient, router]);

  const setWalletLock = useCallback((lock: () => void) => {
    walletLockRef.current = lock;
  }, []);

  const authValue = useMemo<AuthContextValue>(
    () => ({ login, resumeSession, logout }),
    [login, resumeSession, logout],
  );

  // Resume session on app launch
  useEffect(() => {
    if (resumingRef.current) return;
    resumingRef.current = true;

    const stored = getSession();
    if (stored) {
      const newAgent = createAgentForPds(stored.pdsUrl);
      const resumePromise = newAgent.resumeSession(stored.session);
      setAgent(newAgent);
      setStartupDestination("/feeds");
      setReady(true);
      void resumePromise.catch((error: unknown) => {
        logFlow("auth", "startup resumeSession failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setAgent(null);
        showToastable({
          message: tRef.current(
            msg`Sorry! Your session expired. Please log in again.`,
          ),
        });
        store.remove("session");
        setStartupDestination("/");
      });
    } else {
      setReady(true);
    }
  }, [createAgentForPds]);

  // Redirect depending on login state
  useEffect(() => {
    if (startupDestination) {
      if (!rootNavigationState?.key) return;
      if (pathname === startupDestination) {
        requestedStartupDestinationRef.current = null;
        setStartupDestination(null);
        return;
      }
      if (requestedStartupDestinationRef.current === startupDestination) {
        return;
      }
      requestedStartupDestinationRef.current = startupDestination;
      logFlow("nav", "startup redirect", { startupDestination, pathname });
      router.replace(startupDestination === "/feeds" ? "/(feeds)/feeds" : "/");
      return;
    }
    if (!ready || !rootNavigationState?.key) return;
    // @ts-expect-error type is overly specific
    const atRoot = segments.length === 0;
    const inAuthGroup = segments[0] === "(auth)";

    // Never interfere with auth group - let those pages handle their own navigation
    if (inAuthGroup) return;

    // Redirect to landing if not logged in and trying to access protected routes
    if (!agent?.hasSession && !atRoot) {
      logFlow("nav", "redirect to / (no session)", {
        pathname,
        segments,
        hasSession: agent?.hasSession,
        agentDid: agent?.session?.did,
        hasAgent: Boolean(agent),
      });
      router.replace("/");
    }
    // Redirect to feeds if at root with session (initial app launch)
    else if (agent?.hasSession && atRoot) {
      logFlow("nav", "redirect to /feeds (session at root)", {
        pathname,
        agentDid: agent?.session?.did,
      });
      router.replace("/(feeds)/feeds");
    }
  }, [
    segments,
    pathname,
    router,
    agent?.hasSession,
    ready,
    startupDestination,
    rootNavigationState?.key,
  ]);

  useEffect(() => {
    logFlow("nav", "route changed", { pathname, segments });
  }, [pathname, segments]);

  const agentDid = agent?.session?.did;
  const agentHasSession = agent?.hasSession;
  useEffect(() => {
    logFlow("auth", "agent changed", {
      hasAgent: Boolean(agent),
      hasSession: agentHasSession,
      did: agentDid,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentDid, agentHasSession]);

  useEffect(() => {
    logFlow("nav", "App mounted", { pid: Date.now() });
    const sub = AppState.addEventListener("change", (state) => {
      logFlow("nav", "AppState", { state });
    });
    return () => {
      logFlow("nav", "App unmounted");
      sub.remove();
    };
  }, []);

  const splashscreenHidden = useRef(false);

  useEffect(() => {
    if (splashscreenHidden.current) return;
    if (ready && !startupDestination) {
      void SplashScreen.hideAsync()
        .catch(() => console.warn)
        .then(() => Device.getDeviceTypeAsync())
        .then((type) => {
          if (type === Device.DeviceType.TABLET) {
            void ScreenOrientation.unlockAsync();
          }
        });
      splashscreenHidden.current = true;
    }
  }, [ready, startupDestination]);

  // needs i18n context
  useSetupQuickActions();

  return (
    <GestureHandlerRootView className="flex-1">
      <ThemeProvider value={theme}>
        <StatusBar style="auto" applyToNavigationBar />
        <KeyboardProvider>
          <SafeAreaProvider>
            {agent?.hasSession && <QuickActions />}
            <CustomerInfoProvider>
              <AuthProvider value={authValue}>
                <AgentProvider value={agent ?? defaultAgent}>
                  <WalletProvider onLockAvailable={setWalletLock}>
                    <PreferencesProvider>
                      <ActionSheetProvider>
                        <ListProvider>
                          <Stack
                            screenOptions={{
                              headerStyle: {
                                backgroundColor: theme.colors.card,
                              },
                              headerTintColor: theme.colors.primary,
                              headerTitleStyle: {
                                color: theme.colors.text,
                                fontWeight: "700",
                              },
                              headerShadowVisible: false,
                              contentStyle: {
                                backgroundColor: theme.colors.background,
                              },
                            }}
                          >
                            <Stack.Screen
                              name="index"
                              options={{
                                headerShown: false,
                                gestureEnabled: false,
                              }}
                            />
                            <Stack.Screen
                              name="(auth)"
                              options={{
                                headerShown: false,
                                presentation: "formSheet",
                                contentStyle: {
                                  height: "100%",
                                },
                              }}
                            />
                            <Stack.Screen
                              name="settings"
                              options={{
                                headerShown: false,
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="market-rules"
                              options={{
                                title: _(msg`Market Rules`),
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="wallet-link"
                              options={{
                                title: _(msg`Wallet record`),
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="codes"
                              options={{
                                headerShown: false,
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="images/[post]"
                              options={{
                                headerShown: false,
                                animation: "fade",
                                animationMatchesGesture: true,
                              }}
                            />
                            <Stack.Screen
                              name="discover"
                              options={{
                                title: _(msg`Discover Feeds`),
                                presentation: "modal",
                                headerLargeTitle: true,
                                headerLargeTitleShadowVisible: !isIOS26,
                                headerTransparent: isIOS26,
                                headerLargeStyle: {
                                  backgroundColor: isIOS26
                                    ? "transparent"
                                    : theme.colors.background,
                                },
                                headerSearchBarOptions: {},
                              }}
                            />
                            <Stack.Screen
                              name="pro"
                              options={{
                                title: "",
                                headerTransparent: true,
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="circle"
                              options={{
                                title: _(msg`My Circle`),
                                headerTransparent: true,
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="success"
                              options={{
                                title: _(msg`Purchase Successful`),
                                headerShown: false,
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="market-trade"
                              options={{
                                animationMatchesGesture: true,
                                ...Platform.select({
                                  ios: {
                                    presentation: "formSheet",
                                    sheetGrabberVisible: true,
                                    sheetAllowedDetents: [0.85, 1.0],
                                  },
                                  android: {
                                    presentation: "modal",
                                    animation: "slide_from_bottom",
                                  },
                                }),
                              }}
                            />
                            <Stack.Screen
                              name="perpetual-trade"
                              options={{
                                animationMatchesGesture: true,
                                ...Platform.select({
                                  ios: {
                                    presentation: "formSheet",
                                    sheetGrabberVisible: true,
                                    sheetAllowedDetents: [0.85, 1.0],
                                  },
                                  android: {
                                    presentation: "modal",
                                    animation: "slide_from_bottom",
                                  },
                                }),
                              }}
                            />
                            <Stack.Screen
                              name="spot-trade"
                              options={{
                                title: _(msg`Spot trade`),
                                ...Platform.select({
                                  ios: {
                                    presentation: "formSheet",
                                    sheetGrabberVisible: true,
                                    sheetAllowedDetents: [0.85, 1.0],
                                  },
                                  android: {
                                    presentation: "modal",
                                    animation: "slide_from_bottom",
                                  },
                                }),
                              }}
                            />
                            <Stack.Screen
                              name="composer"
                              options={{
                                headerShown: false,
                                ...Platform.select({
                                  ios: {
                                    presentation: "formSheet",
                                    contentStyle: {
                                      height: "100%",
                                    },
                                  },
                                  android: {
                                    animation: "fade_from_bottom",
                                  },
                                }),
                              }}
                            />
                            <Stack.Screen
                              name="edit-bio"
                              options={{
                                title: _(msg`Edit Profile`),
                                ...Platform.select({
                                  ios: {
                                    presentation: "modal",
                                    headerTransparent: true,
                                    headerShadowVisible: true,
                                    headerBlurEffect: !isIOS26
                                      ? theme.dark
                                        ? "systemThickMaterialDark"
                                        : "systemChromeMaterialLight"
                                      : undefined,
                                    headerStyle: {
                                      backgroundColor: !isIOS26
                                        ? theme.dark
                                          ? "rgba(0,0,0,0.4)"
                                          : "rgba(255,255,255,0.1)"
                                        : undefined,
                                    },
                                  },
                                }),
                              }}
                            />
                            <Stack.Screen
                              name="create-list"
                              options={{
                                title: _(msg`Create List`),
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="add-to-list/[handle]"
                              options={{
                                title: _(msg`Add to List`),
                                presentation: "modal",
                              }}
                            />
                            <Stack.Screen
                              name="push-notifications"
                              options={{
                                title: _(msg`Push Notifications`),
                                presentation: "modal",
                                headerShown: false,
                                headerTransparent: true,
                                gestureEnabled: false,
                              }}
                            />
                            <Stack.Screen
                              name="capture/[author]/[post]"
                              options={{
                                title: _(msg`Share as Image`),
                                presentation: "formSheet",
                              }}
                            />
                          </Stack>
                        </ListProvider>
                      </ActionSheetProvider>
                    </PreferencesProvider>
                  </WalletProvider>
                </AgentProvider>
              </AuthProvider>
            </CustomerInfoProvider>
            <Toastable />
          </SafeAreaProvider>
        </KeyboardProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
};

interface StoredSession {
  session: AtpSessionData;
  pdsUrl: string;
}

const getSession = (): StoredSession | null => {
  const raw = store.getString("session");
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StoredSession | AtpSessionData;
  // Handle legacy format (just AtpSessionData without pdsUrl)
  if ("did" in parsed && !("session" in parsed)) {
    return { session: parsed, pdsUrl: defaultPdsUrl };
  }
  return parsed as StoredSession;
};

function RootLayout() {
  useConfigurePurchases();
  useSentryTracing();

  return (
    <I18nProvider>
      <TRPCProvider>
        <App />
      </TRPCProvider>
    </I18nProvider>
  );
}

export default Sentry.wrap(RootLayout);

const QuickActions = () => {
  const fired = useRef<string | null>(null);
  const router = useRouter();
  const action = useQuickAction();

  const href = action?.params?.href;

  useEffect(() => {
    if (typeof href !== "string" || fired.current === href) return;
    fired.current = href;
    router.push(href);
  }, [href, router]);

  return null;
};
