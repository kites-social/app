import { useCallback, useEffect, useState } from "react";

import { polymarketVenue } from "@kites-social/venues/src/prediction-markets/polymarket";
import { type PredictionEventSnapshot } from "@kites-social/venues/src/types";

export const fetchPolymarketEvent = polymarketVenue.fetchEvent;

interface EventState {
  slug?: string;
  data?: PredictionEventSnapshot;
  error?: Error;
  isFetching: boolean;
}

const eventSnapshots = new Map<
  string,
  { data: PredictionEventSnapshot; updatedAt: number }
>();

const readCachedEvent = (slug?: string) => {
  if (!slug) return undefined;
  const cached = eventSnapshots.get(slug);
  if (!cached || Date.now() - cached.updatedAt > 60_000) {
    eventSnapshots.delete(slug);
    return undefined;
  }
  return cached.data;
};

const cacheEvent = (slug: string, data: PredictionEventSnapshot) => {
  eventSnapshots.delete(slug);
  eventSnapshots.set(slug, { data, updatedAt: Date.now() });
  if (eventSnapshots.size > 50) {
    const oldestSlug = eventSnapshots.keys().next().value;
    if (oldestSlug) eventSnapshots.delete(oldestSlug);
  }
};

export const subscribeToPolymarketEvent = (
  slug: string,
  onUpdate: (data: PredictionEventSnapshot) => void,
  onError?: (error: Error) => void,
  marketSlug?: string,
) =>
  polymarketVenue.subscribeToEvent?.(
    slug,
    (data) => {
      cacheEvent(slug, data);
      onUpdate(data);
    },
    onError,
    marketSlug,
  );

export const usePolymarketEvent = (
  slug?: string,
  enabled = true,
  marketSlug?: string,
) => {
  const [state, setState] = useState<EventState>(() => ({
    slug,
    data: readCachedEvent(slug),
    isFetching: enabled && Boolean(slug) && !readCachedEvent(slug),
  }));

  useEffect(() => {
    if (!slug || !enabled) {
      setState((current) =>
        current.slug === slug
          ? { ...current, isFetching: false }
          : { slug, isFetching: false },
      );
      return;
    }

    let active = true;
    const cachedData = readCachedEvent(slug);
    setState((current) =>
      current.slug === slug && current.data
        ? { ...current, error: undefined, isFetching: false }
        : {
            slug,
            data: current.slug === slug ? current.data : cachedData,
            error: undefined,
            isFetching: !cachedData,
          },
    );
    const unsubscribe = subscribeToPolymarketEvent(
      slug,
      (data) => {
        if (active) setState({ slug, data, isFetching: false });
      },
      (error) => {
        if (!active) return;
        setState((current) => ({
          slug,
          data: current.slug === slug ? current.data : undefined,
          error,
          isFetching: false,
        }));
      },
      marketSlug,
    );

    if (!unsubscribe) {
      void fetchPolymarketEvent(slug)
        .then((data) => {
          cacheEvent(slug, data);
          if (active) setState({ slug, data, isFetching: false });
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setState({
            slug,
            error: cause instanceof Error ? cause : new Error(String(cause)),
            isFetching: false,
          });
        });
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [enabled, marketSlug, slug]);

  const refetch = useCallback(async () => {
    if (!slug) return;
    setState((current) => ({
      slug,
      data: current.slug === slug ? current.data : undefined,
      isFetching: true,
    }));
    try {
      const data = await polymarketVenue.refreshEvent(slug);
      cacheEvent(slug, data);
      setState({ slug, data, isFetching: false });
    } catch (cause) {
      setState((current) => ({
        slug,
        data: current.slug === slug ? current.data : undefined,
        error: cause instanceof Error ? cause : new Error(String(cause)),
        isFetching: false,
      }));
    }
  }, [slug]);

  const data = state.slug === slug ? state.data : undefined;
  const error = state.slug === slug ? state.error : undefined;
  const isFetching = state.slug === slug ? state.isFetching : Boolean(slug);
  return {
    data,
    error,
    isFetching,
    isPending: isFetching && !data && !error,
    isError: Boolean(error) && !data,
    refetch,
  };
};
