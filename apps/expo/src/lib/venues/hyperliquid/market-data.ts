import {
  type AllMidsResponse,
  type CandleSnapshotResponse,
  type MetaAndAssetCtxsResponse,
} from "@nktkas/hyperliquid/api/info";

import { type PerpetualMarketSnapshot } from "@kites-social/venues";

import {
  hyperliquidSubscriptionClient,
  requestHyperliquidInfo,
  type ISubscription,
} from "./client";

const CONTEXT_CACHE_MS = 30_000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface MarketContext {
  symbol: string;
  apiSymbol: string;
  priceChange24h?: number;
}

interface MarketListener {
  symbol: string;
  dex: string;
  onUpdate: (market: PerpetualMarketSnapshot) => void;
  onError?: (error: Error) => void;
}

interface Runtime {
  listeners: Set<MarketListener>;
  subscriptions: Map<string, ISubscription>;
  subscriptionRequests: Map<string, Promise<void>>;
  reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
  reconnectAttempts: Map<string, number>;
  contexts: Map<string, { markets: MarketContext[]; expiresAt: number }>;
  contextsRequests: Map<string, Promise<MarketContext[]>>;
}

const runtime: Runtime = {
  listeners: new Set(),
  subscriptions: new Map(),
  subscriptionRequests: new Map(),
  reconnectTimers: new Map(),
  reconnectAttempts: new Map(),
  contexts: new Map(),
  contextsRequests: new Map(),
};

export const hyperliquidPerpetualMarketVenue = {
  id: "hyperliquid",
  name: "Hyperliquid",
  marketType: "perpetual" as const,
  fetchMarket,
  subscribeToMarket,
};

export async function fetchMarket(
  symbol: string,
): Promise<PerpetualMarketSnapshot | null> {
  const normalized = normalizeSymbol(symbol);
  const dex = getDex(symbol);
  const markets = await getMarkets(dex);
  const market = markets.find((item) => item.symbol === normalized);
  if (!market) return null;

  const mids = await requestHyperliquidInfo<AllMidsResponse>({
    type: "allMids",
    ...(dex ? { dex } : {}),
  });
  return createSnapshot(market, mids[market.apiSymbol]);
}

export async function fetchMarketSymbols(): Promise<string[]> {
  return (await getMarkets()).map((market) => market.symbol);
}

export async function fetch24HourPriceHistory(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  const dex = getDex(symbol);
  const market = (await getMarkets(dex)).find(
    (item) => item.symbol === normalized,
  );
  if (!market) return [];

  const endTime = Date.now();
  const candles = await requestHyperliquidInfo<CandleSnapshotResponse>({
    type: "candleSnapshot",
    ...(dex ? { dex } : {}),
    req: {
      coin: market.apiSymbol,
      interval: "1h",
      startTime: endTime - HISTORY_WINDOW_MS,
      endTime,
    },
  });
  return candles.flatMap((candle) => {
    const close = parsePrice(candle.c);
    return close === undefined ? [] : [{ timestamp: candle.t, close }];
  });
}

export function subscribeToMarket(
  symbol: string,
  onUpdate: (market: PerpetualMarketSnapshot) => void,
  onError?: (error: Error) => void,
) {
  const dex = getDex(symbol);
  const listener = {
    symbol: normalizeSymbol(symbol),
    dex,
    onUpdate,
    onError,
  };
  runtime.listeners.add(listener);
  ensureSubscription(dex);

  return () => {
    runtime.listeners.delete(listener);
    if (hasListeners(dex)) return;
    const reconnectTimer = runtime.reconnectTimers.get(dex);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    runtime.reconnectTimers.delete(dex);
    runtime.reconnectAttempts.delete(dex);
    const subscription = runtime.subscriptions.get(dex);
    runtime.subscriptions.delete(dex);
    if (subscription) void subscription.unsubscribe();
  };
}

function ensureSubscription(dex: string) {
  if (
    !hasListeners(dex) ||
    runtime.subscriptions.has(dex) ||
    runtime.subscriptionRequests.has(dex)
  ) {
    return;
  }

  const subscriptionRequest = (async () => {
    const markets = await getMarkets(dex);
    if (!hasListeners(dex)) return;
    const subscription = await hyperliquidSubscriptionClient.allMids(
      dex ? { dex } : {},
      ({ mids }) => {
        for (const listener of runtime.listeners) {
          if (listener.dex !== dex) continue;
          const market = markets.find(
            (item) => item.symbol === listener.symbol,
          );
          if (!market) continue;
          const snapshot = createSnapshot(market, mids[market.apiSymbol]);
          if (snapshot) listener.onUpdate(snapshot);
        }
      },
      {
        onError: (cause) => {
          handleSubscriptionError(dex, toError(cause));
        },
      },
    );
    if (!hasListeners(dex)) {
      await subscription.unsubscribe();
      return;
    }
    runtime.subscriptions.set(dex, subscription);
    runtime.reconnectAttempts.delete(dex);
  })()
    .catch((cause: unknown) => {
      handleSubscriptionError(dex, toError(cause));
    })
    .finally(() => {
      if (runtime.subscriptionRequests.get(dex) === subscriptionRequest) {
        runtime.subscriptionRequests.delete(dex);
      }
    });
  runtime.subscriptionRequests.set(dex, subscriptionRequest);
}

function handleSubscriptionError(dex: string, error: Error) {
  runtime.subscriptions.delete(dex);
  notifyError(error, dex);
  scheduleReconnect(dex);
}

function scheduleReconnect(dex: string) {
  if (!hasListeners(dex) || runtime.reconnectTimers.has(dex)) return;
  const attempt = runtime.reconnectAttempts.get(dex) ?? 0;
  const delay = Math.min(1_000 * 2 ** attempt, 30_000);
  runtime.reconnectAttempts.set(dex, attempt + 1);
  const timer = setTimeout(() => {
    runtime.reconnectTimers.delete(dex);
    ensureSubscription(dex);
  }, delay);
  runtime.reconnectTimers.set(dex, timer);
}

function notifyError(error: Error, dex: string) {
  for (const listener of runtime.listeners) {
    if (listener.dex === dex) listener.onError?.(error);
  }
}

function hasListeners(dex: string) {
  return Array.from(runtime.listeners).some((listener) => listener.dex === dex);
}

async function getMarkets(dex = ""): Promise<MarketContext[]> {
  const cached = runtime.contexts.get(dex);
  if (cached && cached.expiresAt > Date.now()) return cached.markets;
  const existingRequest = runtime.contextsRequests.get(dex);
  if (existingRequest) return existingRequest;

  const contextsRequest = (async () => {
    const [metadata, assetContexts] =
      await requestHyperliquidInfo<MetaAndAssetCtxsResponse>({
        type: "metaAndAssetCtxs",
        ...(dex ? { dex } : {}),
      });
    const markets = assetContexts.flatMap((context, index) => {
      const apiSymbol = metadata.universe[index]?.name ?? "";
      const symbol = normalizeSymbol(apiSymbol);
      if (!symbol) return [];
      const previousPrice = parsePrice(context.prevDayPx);
      return [
        {
          symbol,
          apiSymbol,
          ...(previousPrice === undefined
            ? {}
            : { priceChange24h: previousPrice }),
        },
      ];
    });
    runtime.contexts.set(dex, {
      markets,
      expiresAt: Date.now() + CONTEXT_CACHE_MS,
    });
    return markets;
  })();
  runtime.contextsRequests.set(dex, contextsRequest);
  try {
    return await contextsRequest;
  } finally {
    if (runtime.contextsRequests.get(dex) === contextsRequest) {
      runtime.contextsRequests.delete(dex);
    }
  }
}

function createSnapshot(
  market: MarketContext,
  value: string | undefined,
): PerpetualMarketSnapshot | null {
  const price = parsePrice(value);
  if (price === undefined) return null;
  return {
    symbol: market.symbol,
    name: `${market.symbol}-PERP`,
    price,
    ...(market.priceChange24h === undefined || market.priceChange24h <= 0
      ? {}
      : {
          priceChange24h:
            ((price - market.priceChange24h) / market.priceChange24h) * 100,
        }),
  };
}

function normalizeSymbol(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[-_/](USD|USDT|USDC|PERP|PERPETUAL)$/, "");
}

function getDex(value: string) {
  const separator = value.indexOf(":");
  return separator > 0 ? value.slice(0, separator) : "";
}

function parsePrice(value: string | null | undefined) {
  if (value === undefined || value === null || value.trim() === "") {
    return undefined;
  }
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}
