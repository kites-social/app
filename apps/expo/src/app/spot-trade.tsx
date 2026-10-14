import { Stack, useLocalSearchParams } from "expo-router";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";

import { SpotTradeWidget } from "~/components/widgets/markets/spot/asset";

export default function SpotTradeScreen() {
  const { _ } = useLingui();
  const params = useLocalSearchParams<{
    venue?: string | string[];
    symbol?: string | string[];
  }>();

  return (
    <>
      <Stack.Screen options={{ title: _(msg`Spot trade`) }} />
      <SpotTradeWidget
        venueId={firstParam(params.venue)}
        symbol={firstParam(params.symbol)}
      />
    </>
  );
}

function firstParam(value?: string | string[]) {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
