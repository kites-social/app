import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type PerpetualMarketSnapshot } from "@kites-social/venues";

import {
  fetch24HourPriceHistory,
  fetchMarket,
  fetchMarketSymbols,
  subscribeToMarket,
} from "./market-data";

const marketQueryKey = (symbol: string) =>
  [
    "venues",
    "perpetual",
    "hyperliquid",
    "testnet",
    symbol.toUpperCase(),
  ] as const;

export function useHyperliquidMarket(symbol: string) {
  const queryClient = useQueryClient();
  const [streamError, setStreamError] = useState<Error | undefined>();
  const marketQuery = useQuery({
    queryKey: marketQueryKey(symbol),
    queryFn: () => fetchMarket(symbol),
    staleTime: 15_000,
    refetchInterval: 30_000,
    enabled: Boolean(symbol),
  });

  useEffect(() => {
    if (!symbol) return;
    setStreamError(undefined);
    return subscribeToMarket(
      symbol,
      (market) => {
        setStreamError(undefined);
        queryClient.setQueryData<PerpetualMarketSnapshot | null>(
          marketQueryKey(symbol),
          market,
        );
      },
      setStreamError,
    );
  }, [queryClient, symbol]);

  return { ...marketQuery, streamError };
}

export function useHyperliquidMarketSymbols(enabled: boolean) {
  return useQuery({
    queryKey: ["venues", "perpetual", "hyperliquid", "testnet", "symbols"],
    queryFn: fetchMarketSymbols,
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useHyperliquidPriceHistory(symbol: string, enabled: boolean) {
  return useQuery({
    queryKey: [
      "venues",
      "perpetual",
      "hyperliquid",
      "testnet",
      "history",
      symbol.toUpperCase(),
    ],
    queryFn: () => fetch24HourPriceHistory(symbol),
    staleTime: 60_000,
    enabled: Boolean(symbol) && enabled,
  });
}
