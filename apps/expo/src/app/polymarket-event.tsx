import {
  ActivityIndicator,
  FlatList,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useIsFocused, useTheme } from "@react-navigation/native";
import { RefreshCw } from "lucide-react-native";

import { Text } from "~/components/themed/text";
import { PredictionMarketCard } from "~/components/widgets/markets/prediction/prediction-market-card";
import { usePolymarketEvent } from "~/lib/venues/prediction-markets/polymarket";
import {
  type PredictionEventSnapshot,
  type PredictionMarketSnapshot,
} from "~/lib/venues/types";

export default function PolymarketEventScreen() {
  const theme = useTheme();
  const isFocused = useIsFocused();
  const router = useRouter();
  const { _ } = useLingui();
  const {
    slug: slugParam,
    sourcePostUri: sourcePostUriParam,
    sourcePostCid: sourcePostCidParam,
  } = useLocalSearchParams<{
    slug?: string | string[];
    sourcePostUri?: string | string[];
    sourcePostCid?: string | string[];
  }>();
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam;
  const sourcePostUri = Array.isArray(sourcePostUriParam)
    ? sourcePostUriParam[0]
    : sourcePostUriParam;
  const sourcePostCid = Array.isArray(sourcePostCidParam)
    ? sourcePostCidParam[0]
    : sourcePostCidParam;
  const eventState = usePolymarketEvent(slug, isFocused);
  const event = eventState.data;
  const marketListItems = buildMarketListItems(event);

  return (
    <>
      <Stack.Screen
        options={{
          title: event?.title ?? _(msg`Polymarket Event`),
          headerRight: () =>
            slug ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={_(msg`Refresh market data`)}
                disabled={eventState.isFetching}
                onPress={() => void eventState.refetch()}
                hitSlop={8}
                className="rounded-full p-2"
              >
                {eventState.isFetching ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <RefreshCw size={18} color={theme.colors.text} />
                )}
              </TouchableOpacity>
            ) : null,
        }}
      />
      {!slug ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>This Polymarket event link is invalid.</Trans>
          </Text>
        </View>
      ) : eventState.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Loading markets…</Trans>
          </Text>
        </View>
      ) : eventState.isError ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data is unavailable. Please try again.</Trans>
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void eventState.refetch()}
            className="mt-4 rounded-full px-5 py-2.5"
            style={{ backgroundColor: theme.colors.primary }}
          >
            <Text className="text-sm font-semibold text-white">
              <Trans>Try again</Trans>
            </Text>
          </TouchableOpacity>
        </View>
      ) : event ? (
        <FlatList
          className="flex-1"
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          data={marketListItems}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === "section" ? (
              <View className="flex-row items-center py-2">
                <View
                  className="h-px flex-1"
                  style={{ backgroundColor: theme.colors.border }}
                />
                <Text className="mx-3 text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
                  {item.section === "closed" ? (
                    <Trans>Trading closed</Trans>
                  ) : (
                    <Trans>Resolved</Trans>
                  )}
                </Text>
                <View
                  className="h-px flex-1"
                  style={{ backgroundColor: theme.colors.border }}
                />
              </View>
            ) : (
              <PredictionMarketCard
                market={item.market}
                tradeVenues={[
                  {
                    id: "polymarket",
                    name: "Polymarket",
                    actions: (["yes", "no"] as const).map((outcome) => ({
                      label:
                        outcome === "yes"
                          ? _(msg`Trade YES`)
                          : _(msg`Trade NO`),
                      onPress: () =>
                        router.push({
                          pathname: "/market-trade",
                          params: {
                            provider: "polymarket",
                            eventSlug: slug ?? "",
                            marketSlug: item.market.slug,
                            question: item.market.question,
                            yesProbability: String(item.market.yesProbability),
                            noProbability: String(item.market.noProbability),
                            outcome,
                            sourcePostUri,
                            sourcePostCid,
                          },
                        }),
                    })),
                  },
                ]}
              />
            )
          }
          ItemSeparatorComponent={() => <View className="h-3" />}
          ListHeaderComponent={
            <View className="mb-1">
              <Text className="text-lg font-semibold">{event.title}</Text>
              <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                <Trans>{event.markets.length} markets</Trans>
              </Text>
            </View>
          }
          ListEmptyComponent={
            <Text className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
              {event?.hasResolvedMarkets ? (
                <Trans>This event has resolved markets.</Trans>
              ) : (
                <Trans>
                  No YES/NO markets are available for this event yet.
                </Trans>
              )}
            </Text>
          }
        />
      ) : null}
    </>
  );
}

type MarketListItem =
  | { kind: "section"; key: string; section: "closed" | "resolved" }
  | { kind: "market"; key: string; market: PredictionMarketSnapshot };

function buildMarketListItems(
  event?: PredictionEventSnapshot,
): MarketListItem[] {
  if (!event) return [];

  const activeMarkets = event.markets.filter(
    (market) => !market.isClosed && !market.isResolved,
  );
  const closedMarkets = event.markets.filter(
    (market) => market.isClosed && !market.isResolved,
  );
  const resolvedMarkets = event.markets.filter((market) => market.isResolved);
  const toItems = (markets: PredictionMarketSnapshot[], group: string) =>
    markets.map((market, index) => ({
      kind: "market" as const,
      key: `${group}:${market.slug || `${market.question}-${index}`}`,
      market,
    }));

  return [
    ...toItems(activeMarkets, "active"),
    ...(closedMarkets.length > 0
      ? [
          {
            kind: "section" as const,
            key: "closed-section",
            section: "closed" as const,
          },
          ...toItems(closedMarkets, "closed"),
        ]
      : []),
    ...(resolvedMarkets.length > 0
      ? [
          {
            kind: "section" as const,
            key: "resolved-section",
            section: "resolved" as const,
          },
          ...toItems(resolvedMarkets, "resolved"),
        ]
      : []),
  ];
}
