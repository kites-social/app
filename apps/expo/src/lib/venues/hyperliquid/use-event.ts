import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type PredictionEventSnapshot } from "@kites-social/venues";

import { fetchEvent, subscribeToEvent } from "./prediction-data";

const eventQueryKey = (questionId: string) =>
  ["venues", "prediction", "hyperliquid", "testnet", questionId] as const;

export function useHyperliquidEvent(questionId?: string, enabled = true) {
  const queryClient = useQueryClient();
  const [streamError, setStreamError] = useState<Error | undefined>();
  const eventQuery = useQuery({
    queryKey: eventQueryKey(questionId ?? ""),
    queryFn: () => {
      if (!questionId) throw new Error("A Hyperliquid question is required.");
      return fetchEvent(questionId);
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    enabled: Boolean(questionId) && enabled,
  });

  useEffect(() => {
    if (!questionId || !enabled) return;
    setStreamError(undefined);
    return subscribeToEvent(
      questionId,
      (event) => {
        setStreamError(undefined);
        queryClient.setQueryData<PredictionEventSnapshot>(
          eventQueryKey(questionId),
          event,
        );
      },
      setStreamError,
    );
  }, [enabled, queryClient, questionId]);

  return { ...eventQuery, streamError };
}
