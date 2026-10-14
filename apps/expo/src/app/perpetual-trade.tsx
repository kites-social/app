import { View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";

import { PerplTradeScreen } from "~/components/perpl-trade-screen";
import { Text } from "~/components/themed/text";

export default function PerpetualTradeScreen() {
  const { _ } = useLingui();
  const params = useLocalSearchParams<{
    venue?: string | string[];
    symbol?: string | string[];
    sourcePostUri?: string | string[];
    sourcePostCid?: string | string[];
  }>();
  const venue = firstParam(params.venue);
  const symbol = firstParam(params.symbol);
  const sourcePostUri = firstParam(params.sourcePostUri);
  const sourcePostCid = firstParam(params.sourcePostCid);

  return (
    <>
      <Stack.Screen options={{ title: _(msg`Perpetual trade`) }} />
      {venue === "hyperliquid" ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>Hyperliquid trading is coming soon.</Trans>
          </Text>
        </View>
      ) : venue === "perpl" && symbol ? (
        <PerplTradeScreen
          symbol={symbol}
          sourcePostUri={sourcePostUri}
          sourcePostCid={sourcePostCid}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-neutral-500 dark:text-neutral-400">
            <Trans>This perpetual market is unavailable.</Trans>
          </Text>
        </View>
      )}
    </>
  );
}

function firstParam(value?: string | string[]) {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
