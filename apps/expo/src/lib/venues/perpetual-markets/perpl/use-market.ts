import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type PerpetualMarketSnapshot } from "@kites-social/venues";

import {
  fetch24HourPriceHistory,
  fetchMarket,
  subscribeToMarket,
} from "./market-data";
import { type PerplNetwork } from "./network";

const queryKey = (symbol: string, network: PerplNetwork) =>
  ["venues", "perpetual", "perpl", network, symbol.toUpperCase()] as const;

export function usePerplMarket(
  symbol: string,
  network: PerplNetwork = "testnet",
) {
  const queryClient = useQueryClient();
  const [streamError, setStreamError] = useState<Error | undefined>();
  const marketQuery = useQuery({
    queryKey: queryKey(symbol, network),
    queryFn: () => fetchMarket(symbol, network),
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
          queryKey(symbol, network),
          market,
        );
      },
      setStreamError,
      network,
    );
  }, [network, queryClient, symbol]);

  return {
    ...marketQuery,
    data: marketQuery.data,
    streamError,
  };
}

export function usePerplPriceHistory(symbol: string, enabled: boolean) {
  return useQuery({
    queryKey: ["venues", "perpetual", "perpl", "history", symbol.toUpperCase()],
    queryFn: () => fetch24HourPriceHistory(symbol),
    staleTime: 60_000,
    enabled: Boolean(symbol) && enabled,
  });
}
