import { View } from "react-native";
import { Image } from "expo-image";
import { useMMKVObject } from "react-native-mmkv";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { type AtpSessionData } from "@atproto/api";
import { Trans } from "@lingui/macro";
import { useTheme } from "@react-navigation/native";

import { LinkButton } from "~/components/button";
import { StatusBar } from "~/components/status-bar";
import { Text } from "~/components/themed/text";

export default function LandingPage() {
  const [sessions] = useMMKVObject<AtpSessionData[]>("sessions");
  const theme = useTheme();

  return (
    <View className="flex-1" style={{ backgroundColor: theme.colors.background }}>
      <StatusBar style={theme.dark ? "light" : "dark"} applyToNavigationBar />
      <SafeAreaView className="flex-1 items-stretch justify-between px-6 py-4">
        <View className="items-center pt-20">
          <Image
            source={require("../../assets/icon.png")}
            contentFit="cover"
            style={{ width: 64, height: 64, borderRadius: 20 }}
          />
          <Animated.Text
            entering={FadeIn.delay(100)}
            className="mt-5 text-center text-5xl font-bold tracking-tight"
            style={{ color: theme.colors.text }}
            maxFontSizeMultiplier={1.5}
          >
            Kites
          </Animated.Text>
          <Animated.Text
            entering={FadeIn.delay(250)}
            className="mt-2 text-center text-base"
            style={{ color: theme.dark ? "#A0AAA3" : "#77817C" }}
            maxFontSizeMultiplier={2}
          >
            social conversations, market ideas
          </Animated.Text>
        </View>
        <View className="relative items-center pb-4">
          <Animated.View
            entering={FadeInDown.delay(500)}
            className="w-full max-w-xl"
          >
            <LinkButton
              href={sessions?.length ? "/resume" : "/sign-in"}
              variant="black"
            >
              <Trans>Log in</Trans>
            </LinkButton>
          </Animated.View>
        </View>
      </SafeAreaView>
    </View>
  );
}
