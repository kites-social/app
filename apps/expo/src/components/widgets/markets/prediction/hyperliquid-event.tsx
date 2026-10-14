import { TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Trans } from "@lingui/macro";
import { ArrowRight } from "lucide-react-native";

import { Text } from "~/components/themed/text";
import { radius, useUi } from "~/components/ui/tokens";
import {
  MarketTokenIcon,
  MarketVenueIcon,
} from "~/components/widgets/markets/token-icon";
import { useHyperliquidEvent } from "~/lib/venues/hyperliquid";
import { PredictionMarketCard } from "./prediction-market-card";

export function HyperliquidEventEmbed({
  questionId,
  outcomeId,
  showAll = false,
  enabled = true,
}: {
  questionId: string;
  outcomeId?: string;
  showAll?: boolean;
  enabled?: boolean;
}) {
  const ui = useUi();
  const router = useRouter();
  const eventState = useHyperliquidEvent(questionId, enabled);
  const event = eventState.data;
  const linkedMarket = outcomeId
    ? event?.markets.find((market) => market.slug === outcomeId)
    : undefined;
  const activeMarkets =
    event?.markets.filter((market) => !market.isClosed && !market.isResolved) ??
    [];
  const visibleMarkets = outcomeId
    ? linkedMarket
      ? [linkedMarket]
      : []
    : showAll
      ? (event?.markets ?? [])
      : activeMarkets.slice(0, 1);
  return (
    <View className="mt-2 flex-1">
      <View className="mb-3 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <MarketVenueIcon venue="hyperliquid" />
          <View>
            <Text className="text-xs font-bold tracking-wide text-neutral-800 dark:text-neutral-100">
              HYPERLIQUID
            </Text>
            <Text className="mt-0.5 text-[10px] font-medium tracking-wider text-neutral-500 dark:text-neutral-400">
              <Trans>TESTNET PREDICTION MARKETS</Trans>
            </Text>
          </View>
        </View>
      </View>
      {eventState.isPending ? (
        <Text className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>Loading market…</Trans>
        </Text>
      ) : eventState.isError && !event ? (
        <View className="py-3">
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data is unavailable.</Trans>
          </Text>
        </View>
      ) : event ? (
        <>
          <View className="mb-1 flex-row items-start">
            <MarketTokenIcon symbol="HYPE" />
            <Text className="min-w-0 flex-1 text-lg font-bold leading-6">
              {event.title}
            </Text>
          </View>
          {visibleMarkets.length > 0 ? (
            visibleMarkets.map((market, index) => (
              <PredictionMarketCard
                key={market.slug}
                market={market}
                isLast={index === visibleMarkets.length - 1}
                tradeVenues={[]}
              />
            ))
          ) : (
            <Text className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
              {outcomeId ? (
                <Trans>The linked market is unavailable.</Trans>
              ) : (
                <Trans>
                  No prediction markets are available for this event.
                </Trans>
              )}
            </Text>
          )}
          {!showAll &&
            !outcomeId &&
            visibleMarkets.length < event.markets.length && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() =>
                  router.push({
                    pathname: "/hyperliquid-event",
                    params: { questionId },
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
}
