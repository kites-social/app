import { View } from "react-native";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { useLinkPress } from "~/lib/hooks/link-press";
import { type VenueMarketEmbedView } from "~/lib/market-embed";
import { PerpetualMarketWidget } from "./perpetual/market";
import { HyperliquidEventEmbed } from "./prediction/hyperliquid-event";
import { PolymarketEventEmbed } from "./prediction/polymarket-event";
import { SpotAssetWidget } from "./spot/asset";
import { MarketTradeButton } from "./trade-button";

export function VenueMarketWidget({
  market,
  preview = false,
  sourcePostUri,
  sourcePostCid,
}: {
  market: VenueMarketEmbedView;
  preview?: boolean;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) {
  switch (market.marketType) {
    case "prediction":
      if (market.venue === "hyperliquid") {
        return (
          <HyperliquidEventEmbed
            questionId={market.marketId}
            outcomeId={market.subMarketId}
          />
        );
      }
      if (market.venue === "polymarket") {
        return (
          <PolymarketEventEmbed
            content={{
              $type: "social.kites.embed.polymarket#view",
              url: market.url,
              slug: market.marketId,
              ...(market.subMarketId ? { marketSlug: market.subMarketId } : {}),
            }}
            sourcePostUri={sourcePostUri}
            sourcePostCid={sourcePostCid}
          />
        );
      }
      return <UnsupportedVenueWidget market={market} />;
    case "spot":
      return (
        <SpotAssetWidget
          symbol={market.marketId}
          sourcePostUri={sourcePostUri}
          sourcePostCid={sourcePostCid}
        />
      );
    case "perpetual":
      return (
        <PerpetualMarketWidget
          market={{
            marketType: "perpetual",
            venue: market.venue,
            url: market.url,
            marketId: market.marketId,
          }}
          preview={preview}
          sourcePostUri={sourcePostUri}
          sourcePostCid={sourcePostCid}
        />
      );
  }
}

function UnsupportedVenueWidget({ market }: { market: VenueMarketEmbedView }) {
  const ui = useUi();
  const { _ } = useLingui();
  const { openLink } = useLinkPress();

  return (
    <View
      className="mt-1.5 border p-3.5"
      style={{
        backgroundColor: ui.card,
        borderColor: ui.border,
        borderRadius: radius.card,
        ...continuousCorners,
      }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
          {market.venue} · {market.marketType}
        </Text>
      </View>
      <Text className="mt-2 text-base font-semibold">{market.marketId}</Text>
      <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        <Trans>Trading is not configured for this venue yet.</Trans>
      </Text>
      <MarketTradeButton
        marketName={market.marketId}
        venues={[
          {
            id: market.venue,
            name: market.venue,
            actions: [
              {
                label: _(msg`Open ${market.venue}`),
                onPress: () => void openLink(market.url),
              },
            ],
          },
        ]}
      />
    </View>
  );
}
