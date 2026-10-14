import { ActivityIndicator, TouchableOpacity, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { TrendingDown, TrendingUp } from "lucide-react-native";

import { Text } from "~/components/themed/text";
import { useUi } from "~/components/ui/tokens";
import {
  MarketTokenIcon,
  MarketVenueIcon,
} from "~/components/widgets/markets/token-icon";
import { useLinkPress } from "~/lib/hooks/link-press";
import {
  parseHyperliquidPerpetualMarketUrl,
  useHyperliquidMarket,
  useHyperliquidPriceHistory,
} from "~/lib/venues/hyperliquid";
import { usePerplMarket } from "~/lib/venues/perpetual-markets/perpl";
import { usePerplPriceHistory } from "~/lib/venues/perpetual-markets/perpl/use-market";
import { type PerpetualMarketReference } from "~/lib/venues/types";
import { MarketTradeButton } from "../trade-button";

export function PerpetualMarketWidget({
  market,
  preview = false,
  sourcePostUri,
  sourcePostCid,
}: {
  market: PerpetualMarketReference;
  preview?: boolean;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) {
  if (market.venue === "perpl") {
    return (
      <PerplMarketCard
        market={market}
        preview={preview}
        sourcePostUri={sourcePostUri}
        sourcePostCid={sourcePostCid}
      />
    );
  }
  if (market.venue === "hyperliquid") {
    return <HyperliquidMarketCard market={market} preview={preview} />;
  }

  return <GenericPerpetualMarketCard market={market} preview={preview} />;
}

function GenericPerpetualMarketCard({
  market,
  preview,
}: {
  market: PerpetualMarketReference;
  preview: boolean;
}) {
  const { _ } = useLingui();
  const { openLink } = useLinkPress();

  return (
    <View className={preview ? "mt-2 w-full" : "mt-2 w-full flex-1"}>
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
          {market.venue}
        </Text>
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          <Trans>Perpetual</Trans>
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-lg font-semibold">{market.marketId}</Text>
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">
            <Trans>Perpetual market</Trans>
          </Text>
        </View>
      </View>
      <MarketTradeButton
        marketName={market.marketId}
        venues={[
          {
            id: market.venue,
            name: market.venue,
            actions: [
              {
                label: _(msg`Trade on ${market.venue}`),
                onPress: () => void openLink(market.url),
              },
            ],
          },
        ]}
        preview={preview}
      />
    </View>
  );
}

function PerplMarketCard({
  market,
  preview,
  sourcePostUri,
  sourcePostCid,
}: {
  market: PerpetualMarketReference;
  preview: boolean;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) {
  const ui = useUi();
  const { _ } = useLingui();
  const router = useRouter();
  const marketState = usePerplMarket(market.marketId);
  const currentSymbol = marketState.data?.symbol ?? market.marketId;
  const history = usePerplPriceHistory(
    market.marketId,
    Boolean(marketState.data),
  );
  const marketIdentity = (
    <>
      <MarketVenueIcon venue="perpl" />
      <View>
        <Text className="text-xs font-bold tracking-wide text-neutral-800 dark:text-neutral-100">
          <Trans>PERPL</Trans>
        </Text>
        <Text className="mt-0.5 text-[10px] font-medium tracking-wider text-neutral-500 dark:text-neutral-400">
          <Trans>PERPETUAL MARKETS</Trans>
        </Text>
      </View>
    </>
  );

  return (
    <View className={preview ? "mt-2 w-full" : "mt-2 w-full flex-1"}>
      <View className="mb-3 flex-row items-center">
        <View className="flex-1 flex-row items-center">{marketIdentity}</View>
      </View>

      {marketState.isPending ? (
        <MarketDataLoading height={156} />
      ) : marketState.isError && !marketState.data ? (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void marketState.refetch()}
          className="py-3"
        >
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data is unavailable. Tap to retry.</Trans>
          </Text>
        </TouchableOpacity>
      ) : marketState.data ? (
        <>
          <View className="flex-row items-start justify-between">
            <View className="flex min-w-0 flex-1 flex-row">
              <MarketTokenIcon symbol={marketState.data.symbol} />
              <View className="min-w-0 flex-1">
                <Text className="pr-3 text-lg font-bold leading-6">
                  {marketState.data.symbol}-PERP
                </Text>
                <Text className="mt-1 text-2xl font-bold tabular-nums">
                  {marketState.data.price === null
                    ? "—"
                    : formatPrice(marketState.data.price)}
                </Text>
              </View>
            </View>
            {marketState.data.priceChange24h != null && (
              <PriceChange
                value={marketState.data.priceChange24h}
                timeframe="24h"
              />
            )}
          </View>
          <PriceHistoryChart
            prices={history.data?.map((candle) => candle.close) ?? []}
            loading={history.isPending}
            error={history.isError}
            color={
              (marketState.data.priceChange24h ?? 0) >= 0
                ? ui.positive
                : ui.negative
            }
          />
          <MarketTradeButton
            marketName={`${marketState.data.symbol}-PERP`}
            venues={[
              {
                id: "perpl",
                name: "Perpl",
                actions: [
                  {
                    label: _(msg`Trade Perpl testnet`),
                    onPress: () =>
                      router.push({
                        pathname: "/perpetual-trade",
                        params: {
                          venue: "perpl",
                          symbol: currentSymbol,
                          sourcePostUri,
                          sourcePostCid,
                        },
                      }),
                  },
                ],
              },
            ]}
            preview={preview}
          />
        </>
      ) : (
        <Text className="py-3 text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>This Perpl market is not available.</Trans>
        </Text>
      )}
    </View>
  );
}

function HyperliquidMarketCard({
  market,
  preview,
}: {
  market: PerpetualMarketReference;
  preview: boolean;
}) {
  const ui = useUi();
  const marketId =
    parseHyperliquidPerpetualMarketUrl(market.url)?.marketId ??
    market.marketId;
  const marketState = useHyperliquidMarket(marketId);
  const history = useHyperliquidPriceHistory(
    marketId,
    Boolean(marketState.data),
  );

  return (
    <View className={preview ? "mt-2 w-full" : "mt-2 w-full flex-1"}>
      <View className="mb-3 flex-row items-center">
        <View className="flex-row items-center">
          <MarketVenueIcon venue="hyperliquid" />
          <View>
            <Text className="text-xs font-bold tracking-wide text-neutral-800 dark:text-neutral-100">
              HYPERLIQUID
            </Text>
            <Text className="mt-0.5 text-[10px] font-medium tracking-wider text-neutral-500 dark:text-neutral-400">
              <Trans>PERPETUAL MARKETS</Trans>
            </Text>
          </View>
        </View>
      </View>
      {marketState.isPending ? (
        <MarketDataLoading height={156} />
      ) : marketState.isError && !marketState.data ? (
        <View>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void marketState.refetch()}
            className="py-3"
          >
            <Text className="text-sm text-neutral-500 dark:text-neutral-400">
              <Trans>Market data is unavailable. Tap to retry.</Trans>
            </Text>
          </TouchableOpacity>
        </View>
      ) : marketState.data ? (
        <>
          <View className="flex-row items-start justify-between">
            <View className="flex min-w-0 flex-1 flex-row">
              <MarketTokenIcon symbol={marketState.data.symbol} />
              <View className="min-w-0 flex-1">
                <Text className="pr-3 text-lg font-bold leading-6">
                  {marketState.data.name}
                </Text>
                <Text className="mt-1 text-2xl font-bold tabular-nums">
                  {marketState.data.price === null
                    ? "—"
                    : formatPrice(marketState.data.price)}
                </Text>
              </View>
            </View>
            {marketState.data.priceChange24h != null && (
              <PriceChange
                value={marketState.data.priceChange24h}
                timeframe="24h"
              />
            )}
          </View>
          <PriceHistoryChart
            prices={history.data?.map((candle) => candle.close) ?? []}
            loading={history.isPending}
            error={history.isError}
            color={
              (marketState.data.priceChange24h ?? 0) >= 0
                ? ui.positive
                : ui.negative
            }
          />
        </>
      ) : (
        <View className="py-3">
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            <Trans>Market data is unavailable.</Trans>
          </Text>
        </View>
      )}
    </View>
  );
}

function PriceChange({
  value,
  timeframe,
  className = "",
}: {
  value: number;
  timeframe?: string;
  className?: string;
}) {
  const positive = value >= 0;
  const ui = useUi();
  const color = positive ? ui.positive : ui.negative;
  const Icon = positive ? TrendingUp : TrendingDown;

  return (
    <View
      className={`flex-row items-center rounded-full px-2.5 py-1 ${className}`}
      style={{
        backgroundColor: positive ? ui.positiveSoft : ui.negativeSoft,
      }}
    >
      <Icon size={13} color={color} />
      <Text className="ml-1 text-xs font-semibold" style={{ color }}>
        {timeframe ? `${timeframe} ` : ""}
        {positive ? "+" : ""}
        {value.toFixed(2)}%
      </Text>
    </View>
  );
}

function PriceHistoryChart({
  prices,
  loading,
  error,
  color,
}: {
  prices: number[];
  loading: boolean;
  error: boolean;
  color: string;
}) {
  if (loading) {
    return (
      <View className="mt-3 h-[84px] w-full items-center justify-center">
        <ActivityIndicator size="small" />
      </View>
    );
  }
  if (error || prices.length < 2) {
    return (
      <View className="mt-3 h-[84px] w-full justify-center">
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          {error ? (
            <Trans>Price history is unavailable.</Trans>
          ) : (
            <Trans>Not enough price history to chart.</Trans>
          )}
        </Text>
      </View>
    );
  }

  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const range = maximum - minimum || 1;
  const points = prices
    .map((price, index) => {
      const x = (index / (prices.length - 1)) * 320;
      const y = 62 - ((price - minimum) / range) * 50;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <View className="mt-3 h-[84px] w-full">
      <Svg
        width="100%"
        height={68}
        viewBox="0 0 320 68"
        preserveAspectRatio="none"
      >
        <Polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      <View className="mt-1 flex-row justify-between">
        <Text className="text-[10px] text-neutral-500 dark:text-neutral-400">
          <Trans>24 hours ago</Trans>
        </Text>
        <Text className="text-[10px] text-neutral-500 dark:text-neutral-400">
          <Trans>Now</Trans>
        </Text>
      </View>
    </View>
  );
}

function MarketDataLoading({ height }: { height: number }) {
  return (
    <View className="w-full items-center justify-center" style={{ height }}>
      <ActivityIndicator size="small" />
      <Text className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
        <Trans>Loading live market data…</Trans>
      </Text>
    </View>
  );
}

function formatPrice(price: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 7,
  }).format(price);
}
