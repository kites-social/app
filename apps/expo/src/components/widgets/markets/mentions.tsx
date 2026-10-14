import { type ReactNode } from "react";
import { View } from "react-native";
import { Trans } from "@lingui/macro";

import { getPerplMarketIdForTicker } from "@kites-social/venues";

import { Text } from "~/components/themed/text";
import { PerpetualMarketWidget } from "~/components/widgets/markets/perpetual/market";
import { SpotAssetWidget } from "~/components/widgets/markets/spot/asset";
import {
  HYPERLIQUID_TESTNET_APP_URL,
  useHyperliquidMarketSymbols,
} from "~/lib/venues/hyperliquid";
import { spotAssetRegistry, spotMarketVenues } from "~/lib/venues/registry";

export function TickerMarketMentions({ text }: { text: string }) {
  const symbols = Array.from(
    new Set(
      Array.from(text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,9})\b/g), (match) =>
        match[1]!.toUpperCase(),
      ),
    ),
  );
  const marketSymbols = useHyperliquidMarketSymbols(symbols.length > 0);
  const hyperliquidSymbols = new Set(marketSymbols.data ?? []);

  const cards = symbols.flatMap((symbol) => {
    const cards: ReactNode[] = [];
    const perplMarketId = getPerplMarketIdForTicker(symbol);
    if (perplMarketId) {
      cards.push(
        <PerpetualMarketWidget
          key={`perpl:${symbol}`}
          market={{
            marketType: "perpetual",
            venue: "perpl",
            marketId: perplMarketId,
            url: `https://testnet.perpl.xyz/trade/${encodeURIComponent(perplMarketId)}`,
          }}
          preview
        />,
      );
    }
    if (hyperliquidSymbols.has(symbol)) {
      cards.push(
        <PerpetualMarketWidget
          key={`hyperliquid:${symbol}`}
          market={{
            marketType: "perpetual",
            venue: "hyperliquid",
            marketId: symbol,
            url: `${HYPERLIQUID_TESTNET_APP_URL}/trade/${encodeURIComponent(symbol)}`,
          }}
          preview
        />,
      );
    }
    if (spotAssetRegistry[symbol] && spotMarketVenues.length > 0) {
      cards.push(<SpotAssetWidget key={`spot:${symbol}`} symbol={symbol} />);
    }
    return cards;
  });

  if (cards.length === 0 && !marketSymbols.isError) return null;

  return (
    <View className="gap-2">
      {cards}
      {marketSymbols.isError && symbols.length > 0 && (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>Hyperliquid ticker availability could not be loaded.</Trans>
        </Text>
      )}
    </View>
  );
}
