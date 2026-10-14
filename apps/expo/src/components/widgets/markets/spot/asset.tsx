import { View } from "react-native";
import { useRouter } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQuery } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { continuousCorners, radius, useUi } from "~/components/ui/tokens";
import { spotAssetRegistry, spotMarketVenues } from "~/lib/venues/registry";
import { type SpotMarketVenue } from "~/lib/venues/types";
import { MarketTradeButton } from "../trade-button";

export function SpotAssetWidget({
  symbol,
  sourcePostUri,
  sourcePostCid,
}: {
  symbol: string;
  sourcePostUri?: string;
  sourcePostCid?: string;
}) {
  const ui = useUi();
  const router = useRouter();
  const { _ } = useLingui();
  const asset = spotAssetRegistry[symbol];

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
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
          <Trans>Spot asset</Trans>
        </Text>
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">
          {asset?.name ?? `$${symbol}`}
        </Text>
      </View>
      {spotMarketVenues.length ? (
        <View className="gap-2">
          {spotMarketVenues.map((venue) => (
            <VenueAssetRow key={venue.id} venue={venue} symbol={symbol} />
          ))}
          <MarketTradeButton
            marketName={`$${symbol}`}
            venues={spotMarketVenues.map((venue) => ({
              id: venue.id,
              name: venue.name,
              actions: [
                {
                  label: _(msg`Trade on ${venue.name}`),
                  onPress: () =>
                    router.push({
                      pathname: "/spot-trade",
                      params: { venue: venue.id, symbol, sourcePostUri, sourcePostCid },
                    }),
                },
              ],
            }))}
          />
        </View>
      ) : (
        <Text className="text-sm text-neutral-500 dark:text-neutral-400">
          <Trans>No spot exchanges are configured yet.</Trans>
        </Text>
      )}
    </View>
  );
}

function VenueAssetRow({
  venue,
  symbol,
}: {
  venue: SpotMarketVenue;
  symbol: string;
}) {
  const ui = useUi();
  const assetQuery = useQuery({
    queryKey: ["venues", "spot", venue.id, "asset", symbol],
    queryFn: () => venue.fetchAsset(symbol),
    staleTime: 15_000,
  });

  return (
    <View
      className="min-h-11 flex-row items-center justify-between px-3"
      style={{
        backgroundColor: ui.inset,
        borderRadius: radius.control,
        ...continuousCorners,
      }}
    >
      <Text className="font-semibold">{venue.name}</Text>
      <Text className="text-sm text-neutral-500 dark:text-neutral-400">
        {assetQuery.isError ? (
          <Trans>Price unavailable: {assetQuery.error.message}</Trans>
        ) : assetQuery.data?.price == null ? (
          <Trans>Price unavailable</Trans>
        ) : (
          formatPrice(assetQuery.data.price)
        )}
      </Text>
    </View>
  );
}

export function SpotTradeWidget({
  venueId,
  symbol,
}: {
  venueId: string;
  symbol: string;
}) {
  const ui = useUi();
  const venue = spotMarketVenues.find((item) => item.id === venueId);
  const assetQuery = useQuery({
    queryKey: ["venues", "spot", venueId, "asset", symbol],
    queryFn: () => {
      if (!venue) throw new Error(`Spot venue "${venueId}" is not configured`);
      return venue.fetchAsset(symbol);
    },
    enabled: !!venue,
    staleTime: 15_000,
  });

  return (
    <View
      className="m-4 border p-4"
      style={{
        backgroundColor: ui.card,
        borderColor: ui.border,
        borderRadius: radius.card,
        ...continuousCorners,
      }}
    >
      <Text className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
        {venue?.name ?? venueId} · SPOT
      </Text>
      <Text className="mt-2 text-xl font-semibold">${symbol}</Text>
      {assetQuery.data?.price != null && (
        <Text className="mt-1 text-sm">
          {formatPrice(assetQuery.data.price)}
        </Text>
      )}
      {assetQuery.isError && (
        <Text className="mt-1 text-sm" style={{ color: ui.negative }}>
          {assetQuery.error.message}
        </Text>
      )}
      <Text className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
        {venue ? (
          <Trans>Swapping for this venue is not connected yet.</Trans>
        ) : (
          <Trans>This spot venue is not configured yet.</Trans>
        )}
      </Text>
    </View>
  );
}

function formatPrice(price: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 6,
  }).format(price);
}
