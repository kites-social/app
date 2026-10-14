import { TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { ArrowRight } from "lucide-react-native";

import { Text } from "~/components/themed/text";
import { radius, useUi } from "~/components/ui/tokens";
import {
  MarketImageIcon,
  MarketVenueIcon,
} from "~/components/widgets/markets/token-icon";
import { useLinkPress } from "~/lib/hooks/link-press";
import {
  sortPolymarketMarkets,
  usePolymarketEvent,
} from "~/lib/venues/prediction-markets/polymarket";
import { type PolymarketEmbedView } from "~/lib/venues/prediction-markets/polymarket/embed";
import { PredictionMarketCard } from "./prediction-market-card";

const MAX_MARKETS = 1;

export const PolymarketEventEmbed = ({
  content,
  sourcePostUri,
  sourcePostCid,
}: {
  content: PolymarketEmbedView;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) => {
  const ui = useUi();
  const router = useRouter();
  const { _ } = useLingui();
  const { openLink, showLinkOptions } = useLinkPress();
  const eventState = usePolymarketEvent(content.slug, true, content.marketSlug);

  const event = eventState.data;
  const linkedMarket = content.marketSlug
    ? event?.markets.find((market) => market.slug === content.marketSlug)
    : undefined;
  const activeMarkets =
    event?.markets.filter((market) => !market.isClosed && !market.isResolved) ??
    [];
  const prioritizedMarkets = event ? sortPolymarketMarkets(event.markets) : [];
  const visibleMarkets = content.marketSlug
    ? linkedMarket
      ? [linkedMarket]
      : []
    : activeMarkets.length > 0
      ? activeMarkets.slice(0, MAX_MARKETS)
      : prioritizedMarkets.slice(0, MAX_MARKETS);
  const imageUrl =
    linkedMarket?.imageUrl ??
    event?.imageUrl ??
    event?.markets.find((market) => market.imageUrl)?.imageUrl;

  return (
    <View className="mt-2 flex-1">
      <View className="mb-3 flex-row items-center justify-between">
        <TouchableOpacity
          accessibilityRole="link"
          onPress={() => openLink(content.url)}
          onLongPress={() => showLinkOptions(content.url)}
          className="flex-row items-center"
          activeOpacity={0.75}
        >
          <MarketVenueIcon venue="polymarket" />
          <View>
            <Text className="text-xs font-bold tracking-wide text-neutral-800 dark:text-neutral-100">
              <Trans>POLYMARKET</Trans>
            </Text>
            <Text className="mt-0.5 text-[10px] font-medium tracking-wider text-neutral-500 dark:text-neutral-400">
              <Trans>PREDICTION MARKETS</Trans>
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {eventState.isPending ? (
        <Text className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>Loading market…</Trans>
        </Text>
      ) : eventState.isError ? (
        <TouchableOpacity
          accessibilityRole="link"
          onPress={() => openLink(content.url)}
          onLongPress={() => showLinkOptions(content.url)}
          className="py-3"
        >
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data is unavailable. Tap to open Polymarket.</Trans>
          </Text>
        </TouchableOpacity>
      ) : event ? (
        <>
          <View className="mb-1 flex-row items-start">
            <MarketImageIcon
              key={imageUrl}
              imageUrl={imageUrl}
              fallbackVenue="polymarket"
            />
            <Text className="min-w-0 flex-1 text-lg font-bold leading-6">
              {event.title}
            </Text>
          </View>
          {visibleMarkets.length > 0 ? (
            visibleMarkets.map((market, index) => (
              <PredictionMarketCard
                key={market.slug || market.question}
                market={market}
                isLast={index === visibleMarkets.length - 1}
                tradeVenues={[
                  {
                    id: "polymarket",
                    name: "Polymarket",
                    actions: (["yes", "no"] as const).map((outcome) => ({
                      label: _(msg`Trade ${outcome.toUpperCase()}`),
                      onPress: () =>
                        router.push({
                          pathname: "/market-trade",
                          params: {
                            provider: "polymarket",
                            eventSlug: content.slug,
                            marketSlug: market.slug,
                            question: market.question,
                            yesProbability: String(market.yesProbability),
                            noProbability: String(market.noProbability),
                            outcome,
                            sourcePostUri,
                            sourcePostCid,
                          },
                        }),
                    })),
                  },
                ]}
              />
            ))
          ) : (
            <Text className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
              {content.marketSlug ? (
                <Trans>
                  The linked market is unavailable. Tap to open Polymarket.
                </Trans>
              ) : event.hasResolvedMarkets ? (
                <Trans>This event has resolved markets.</Trans>
              ) : (
                <Trans>
                  No YES/NO markets are available for this event yet.
                </Trans>
              )}
            </Text>
          )}
          {!content.marketSlug &&
            visibleMarkets.length < event.markets.length && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() =>
                  router.push({
                    pathname: "/polymarket-event",
                    params: {
                      slug: content.slug,
                      sourcePostUri,
                      sourcePostCid,
                    },
                  })
                }
                activeOpacity={0.75}
                className="mt-2 flex-row items-center self-end px-3.5 py-2"
                style={{
                  backgroundColor: ui.primarySoft,
                  borderRadius: radius.pill,
                }}
              >
                <Text
                  className="text-xs font-semibold"
                  style={{ color: ui.primary }}
                >
                  <Trans>View all {event.markets.length} markets</Trans>
                </Text>
                <ArrowRight
                  size={12}
                  color={ui.primary}
                  style={{ marginLeft: 4 }}
                />
              </TouchableOpacity>
            )}
        </>
      ) : null}
    </View>
  );
};
