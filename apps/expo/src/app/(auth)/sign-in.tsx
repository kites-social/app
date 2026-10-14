import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { showToastable } from "react-native-toastable";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useMutation } from "@tanstack/react-query";
import { LockIcon, ShieldAlertIcon, UserIcon } from "lucide-react-native";
import { z } from "zod";

import { Button } from "~/components/button";
import { TextButton } from "~/components/text-button";
import { Text } from "~/components/themed/text";
import { TextInput } from "~/components/themed/text-input";
import { TransparentHeaderUntilScrolled } from "~/components/transparent-header";
import { useAuth } from "~/lib/agent";
import { logFlow } from "~/lib/flow-log";
import { useLinkPress } from "~/lib/hooks/link-press";

type LoginError = Error & {
  error?: string;
  status?: number;
};

const getLoginErrorDetails = (err: unknown) => {
  const error = err instanceof Error ? (err as LoginError) : undefined;
  const message = error?.message || String(err);
  const code = error?.error;
  const status = error?.status;
  const isNetworkError =
    /network request failed|failed to fetch|fetch failed|timed out|timeout/i.test(
      message,
    );

  const httpStatus = status !== undefined && status >= 100 ? status : undefined;
  const title = isNetworkError
    ? "Network error"
    : httpStatus === 401 || httpStatus === 403
      ? "Authentication failed"
      : "Login failed";
  const detail = [
    code && code !== "Unknown" && code !== message ? code : undefined,
    message,
    httpStatus
      ? `HTTP ${httpStatus}`
      : isNetworkError
        ? "No HTTP response"
        : undefined,
  ]
    .filter(Boolean)
    .join(" — ");

  return { title, detail, status: httpStatus, code, message };
};

export default function SignIn() {
  const { login: authLogin } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const { handle } = useLocalSearchParams<{ handle?: string }>();
  const { openLink, showLinkOptions } = useLinkPress();
  const { _ } = useLingui();
  const insets = useSafeAreaInsets();

  const [identifier, setIdentifier] = useState(handle ?? "");
  const [password, setPassword] = useState("");
  const [hasFocusedPassword, setHasFocusedPassword] = useState(false);

  const login = useMutation({
    mutationKey: ["login"],
    mutationFn: async () => {
      const normalizedIdentifier = identifier.startsWith("@")
        ? identifier.slice(1).trim()
        : identifier.trim();
      await authLogin(normalizedIdentifier, password);
    },
    onSuccess: () => {
      // Dismiss the auth modal and navigate to feeds
      if (router.canDismiss()) {
        router.dismissAll();
      }
      router.replace("/(feeds)/feeds");
    },
    onError: (err) => {
      const details = getLoginErrorDetails(err);
      logFlow("auth", "login failed", {
        status: details.status,
        code: details.code,
        message: details.message,
      });
      showToastable({
        title: details.title,
        message: details.detail,
        status: "warning",
      });
    },
  });

  return (
    <>
      <Stack.Screen options={{ headerRight: () => null }} />
      <TransparentHeaderUntilScrolled>
        <KeyboardAwareScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerStyle={{ padding: 20, gap: 18 }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View className="items-center pb-1 pt-4">
            <View
              className="mb-3 h-14 w-14 items-center justify-center rounded-[18px]"
              style={{ backgroundColor: theme.colors.primary }}
            >
              <Svg width={28} height={28} viewBox="0 0 24 24">
                <Path
                  d="M12 2.5 21 11l-9 10.5L3 11 12 2.5Z"
                  fill="none"
                  stroke="white"
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                <Path
                  d="m7 11 5 4 5-4"
                  fill="none"
                  stroke="white"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
            <Text
              accessibilityRole="header"
              className="text-center text-2xl font-bold"
            >
              <Trans>Log in</Trans> <Text>Kites</Text>
            </Text>
          </View>
          <View className="justify-stretch">
            <View
              className="mb-3 flex-row items-center rounded-2xl border pl-4"
              style={{
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
              }}
            >
              <UserIcon size={18} color="rgb(163 163 163)" />
              <TextInput
                className="flex-1 flex-row items-center border-0 px-3 py-4 text-base leading-5"
                placeholder={_(msg`Username or email address`)}
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                onBlur={() => {
                  let fixed = identifier;
                  if (identifier.startsWith("@")) fixed = identifier.slice(1);
                  if (!identifier.includes(".") && identifier.length > 0)
                    fixed = `${fixed}.bsky.social`;
                  setIdentifier(fixed);
                }}
                autoFocus={!handle}
              />
            </View>
            <View
              className="flex-row items-center rounded-2xl border pl-4"
              style={{
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
              }}
            >
              <LockIcon size={18} color="rgb(163 163 163)" />
              <TextInput
                className="flex-1 flex-row items-center border-0 px-3 py-4 text-base leading-5"
                placeholder={_(msg`App Password`)}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                onFocus={() => setHasFocusedPassword(true)}
                autoFocus={!!handle}
              />
              <TextButton
                onPress={() => {
                  if (z.string().email().safeParse(identifier).success) {
                    router.push("/reset-password?email=" + identifier);
                  } else {
                    router.push("/reset-password");
                  }
                }}
                title={_(msg`Forgot?`)}
                className="pr-3 text-sm"
              />
            </View>
          </View>
          {hasFocusedPassword && (
            <Animated.View
              entering={FadeIn}
              exiting={FadeOut}
              className="flex-row rounded-2xl border p-4 pb-4"
              style={{
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.primary,
                backgroundColor: theme.dark ? "#18211B" : "#E8F8EF",
              }}
            >
              <ShieldAlertIcon
                size={18}
                className="mt-px"
                color={theme.colors.primary}
              />
              <View className="ml-3 flex-1">
                <Text className="text-base font-medium leading-5">
                  <Trans>App Passwords</Trans>
                </Text>
                <Text className="mt-1">
                  <Trans>
                    You might want to use an App Password rather than your main
                    password - this helps keep your account secure, but it{"'"}s
                    not required.
                  </Trans>
                </Text>
                <Text
                  className="mt-2"
                  primary
                  accessibilityRole="link"
                  onPress={() =>
                    openLink("https://bsky.app/settings/app-passwords")
                  }
                  onLongPress={() =>
                    showLinkOptions("https://bsky.app/settings/app-passwords")
                  }
                >
                  <Trans>Create one at bsky.app/settings</Trans>
                </Text>
              </View>
            </Animated.View>
          )}
        </KeyboardAwareScrollView>
      </TransparentHeaderUntilScrolled>
      <KeyboardStickyView
        className="px-4"
        offset={{ closed: insets.bottom * -1, opened: 16 * -1 }}
      >
        <Button
          loading={login.isPending}
          disabled={!identifier || !password || login.isPending}
          onPress={() => login.mutate()}
        >
          {login.isPending ? <Trans>Logging in…</Trans> : <Trans>Log in</Trans>}
        </Button>
      </KeyboardStickyView>
    </>
  );
}
