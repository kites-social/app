import { useCallback, useRef, useState } from "react";
import {
  ImageSourcePropType,
  Platform,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { AppleIcon } from "react-native-bottom-tabs";
import { Drawer } from "react-native-drawer-layout";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { Stack, usePathname, useRouter, useSegments } from "expo-router";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react-native";

import { BackButtonOverride } from "~/components/back-button-override";
import { Tabs } from "~/components/bottom-tabs";
import { DrawerProvider } from "~/components/drawer/context";
import { DrawerContent } from "~/components/drawer/drawer-content";
import { StatusBar } from "~/components/status-bar";
import { SwitchAccounts } from "~/components/switch-accounts";
import { Text } from "~/components/themed/text";
import { WalletLockedOverlay } from "~/components/wallet-locked-overlay";
import { useOptionalAgent } from "~/lib/agent";
import { useBottomSheetStyles } from "~/lib/bottom-sheet";
import { useNotifications } from "~/lib/hooks/notifications";
import { useHaptics } from "~/lib/hooks/preferences";
import { useHomepage } from "~/lib/storage/app-preferences";
import { useRefreshOnFocus } from "~/lib/utils/query";

export default function AppLayout() {
  // agent might not be available yet
  const agent = useOptionalAgent();
  const [open, setOpen] = useState(false);
  const { _ } = useLingui();

  useNotifications();

  const notifications = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: async () => {
      if (!agent?.hasSession) return null;
      const unreadCount = await agent.countUnreadNotifications();
      if (!unreadCount.success)
        throw new Error("Failed to fetch notifications");
      await Notifications.setBadgeCountAsync(
        Math.min(unreadCount.data.count, 30),
      );
      return unreadCount.data;
    },
    // refetch every 15 seconds
    refetchInterval: 1000 * 15,
  });

  useRefreshOnFocus(notifications.refetch);

  const renderDrawerContent = useCallback(
    () => <DrawerContent open={open} />,
    [open],
  );

  const openDrawer = useCallback((open = true) => setOpen(open), []);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => setOpen(false), []);

  const theme = useTheme();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();

  const homepage = useHomepage();

  const accountRef = useRef<BottomSheetModal>(null);
  const { top, bottom } = useSafeAreaInsets();
  const {
    backgroundStyle,
    handleStyle,
    handleIndicatorStyle,
    contentContainerStyle,
  } = useBottomSheetStyles();
  const haptics = useHaptics();
  const dimensions = useWindowDimensions();

  const dismissSheet = useCallback(() => accountRef.current?.dismiss(), []);

  const reducedMotion = useReducedMotion();

  return (
    <DrawerProvider value={openDrawer}>
      <View className="flex-1">
        <BottomSheetModal
          ref={accountRef}
          enablePanDownToClose
          snapPoints={["40%", dimensions.height - top - 10]}
          backdropComponent={(props) => (
            <BottomSheetBackdrop
              {...props}
              appearsOnIndex={0}
              disappearsOnIndex={-1}
            />
          )}
          handleIndicatorStyle={handleIndicatorStyle}
          handleStyle={handleStyle}
          backgroundStyle={backgroundStyle}
          enableDismissOnClose
          detached
          animateOnMount={!reducedMotion}
        >
          <BackButtonOverride dismiss={dismissSheet} />
          <Text className="my-2 text-center text-xl font-medium">
            <Trans>Switch Accounts</Trans>
          </Text>
          <BottomSheetScrollView style={contentContainerStyle}>
            <SwitchAccounts
              active={agent?.session?.did}
              onSuccessfulSwitch={dismissSheet}
            />
          </BottomSheetScrollView>
        </BottomSheetModal>
        <StatusBar />
        <Stack.Screen
          options={{
            headerShown: false,
            animation: "none",
            gestureEnabled: false,
          }}
        />
        <Drawer
          open={open}
          onOpen={onOpen}
          onClose={onClose}
          renderDrawerContent={renderDrawerContent}
          drawerType="slide"
          drawerStyle={{
            width: Math.min(dimensions.width * 0.8, 400),
            backgroundColor: theme.colors.card,
          }}
          swipeEdgeWidth={dimensions.width}
          // @ts-expect-error types are overly specific
          swipeEnabled={segments.length === 3}
        >
          <View className="flex-1">
            <Tabs
              sidebarAdaptable
              labeled={Platform.OS !== "ios"}
              tabBarStyle={
                Platform.OS === "android"
                  ? { backgroundColor: theme.colors.card }
                  : undefined
              }
              activeIndicatorColor={theme.dark ? "#173526" : "#e8f8ef"}
              tabBarActiveTintColor={theme.colors.primary}
            >
              <Tabs.Screen
                name="(feeds)"
                options={{
                  title: homepage === "feeds" ? _(msg`Feeds`) : _(msg`Skyline`),
                  tabBarIcon:
                    homepage === "feeds"
                      ? ({ focused }) =>
                          Platform.select<ImageSourcePropType | AppleIcon>({
                            ios: {
                              sfSymbol: focused ? "house.fill" : "house",
                            },
                            default:
                              // eslint-disable-next-line @typescript-eslint/no-require-imports
                              require("../../../assets/tabs/house.svg") as ImageSourcePropType,
                          })
                      : ({ focused }) =>
                          Platform.select<ImageSourcePropType | AppleIcon>({
                            ios: {
                              sfSymbol: focused ? "house.fill" : "house",
                            },

                            default:
                              // eslint-disable-next-line @typescript-eslint/no-require-imports
                              require("../../../assets/tabs/house.svg") as ImageSourcePropType,
                          }),
                }}
              />
              <Tabs.Screen
                name="(search)"
                options={{
                  title: _(msg`Search`),
                  tabBarIcon: () =>
                    Platform.select<ImageSourcePropType | AppleIcon>({
                      ios: {
                        sfSymbol: "magnifyingglass",
                      },
                      default:
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        require("../../../assets/tabs/search.svg") as ImageSourcePropType,
                    }),
                }}
              />
              <Tabs.Screen
                name="wallet"
                options={{
                  title: _(msg`Wallet`),
                  tabBarIcon: ({ focused }) =>
                    Platform.select<ImageSourcePropType | AppleIcon>({
                      ios: {
                        sfSymbol: focused ? "wallet.pass.fill" : "wallet.pass",
                      },
                      default:
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        require("../../../assets/tabs/wallet.svg") as ImageSourcePropType,
                    }),
                }}
              />
              <Tabs.Screen
                name="null"
                options={{
                  tabBarItemHidden: true,
                }}
                listeners={{
                  tabPress: () => {
                    if (agent?.hasSession) {
                      if (segments.at(-2) === "profile") {
                        const actor = pathname.split("/").pop()!;
                        try {
                          if (actor.startsWith("did:")) {
                            if (actor === agent.session?.did)
                              throw new Error("Cannot mention yourself");
                            void agent.getProfile({ actor }).then((profile) => {
                              if (!profile.success)
                                throw new Error("Failed to fetch profile");
                              router.push(
                                `/composer/?initialText=@${profile.data.handle}`,
                              );
                            });
                          } else {
                            if (actor === agent.session?.handle)
                              throw new Error("Cannot mention yourself");
                            router.push(`/composer/?initialText=@${actor}`);
                          }
                        } catch (err) {
                          console.error(err);
                          router.push("/composer");
                        }
                      } else {
                        router.push("/composer");
                      }
                    }
                  },
                }}
              />
              <Tabs.Screen
                name="(notifications)"
                options={{
                  title: _(msg`Notifications`),
                  tabBarBadge: notifications.data?.count
                    ? notifications.data.count > 30
                      ? "30+"
                      : String(notifications.data.count)
                    : undefined,
                  tabBarIcon: ({ focused }) =>
                    Platform.select<ImageSourcePropType | AppleIcon>({
                      ios: {
                        sfSymbol: focused ? "bell.fill" : "bell",
                      },
                      default:
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        require("../../../assets/tabs/bell.svg") as ImageSourcePropType,
                    }),
                }}
              />
              <Tabs.Screen
                name="(self)"
                options={{
                  title: _(msg`Profile`),
                  tabBarIcon: ({ focused }) =>
                    Platform.select<ImageSourcePropType | AppleIcon>({
                      ios: {
                        sfSymbol: focused ? "person.fill" : "person",
                      },
                      default:
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        require("../../../assets/tabs/user.svg") as ImageSourcePropType,
                    }),
                }}
                listeners={{
                  tabLongPress: () => {
                    haptics.selection();
                    accountRef.current?.present();
                  },
                }}
              />
            </Tabs>
            {agent?.hasSession && !segments.includes("wallet") && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={_(msg`Create a post`)}
                onPress={() => router.push("/composer")}
                className="absolute right-5 h-14 w-14 items-center justify-center rounded-2xl"
                style={{
                  bottom: Math.max(bottom, 10) + 96,
                  backgroundColor: theme.colors.primary,
                  elevation: 7,
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.25,
                  shadowRadius: 5,
                }}
              >
                <PlusIcon size={28} color="white" strokeWidth={2.5} />
              </TouchableOpacity>
            )}
          </View>
        </Drawer>
        {segments.includes("wallet") && (
          <WalletLockedOverlay bottomInset={bottom} />
        )}
      </View>
    </DrawerProvider>
  );
}
