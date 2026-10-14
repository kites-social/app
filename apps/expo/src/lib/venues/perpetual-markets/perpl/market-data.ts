import { type PerpetualMarketSnapshot } from "@kites-social/venues";

import { PERPL_NETWORKS, type PerplNetwork } from "./network";

const CONTEXT_CACHE_MS = 5 * 60 * 1_000;
const CANDLE_RESOLUTION_SECONDS = 3_600;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface PerplMarketConfig {
  id: number;
  symbol: string;
  name: string;
  priceDecimals: number;
  sizeDecimals?: number;
}

export interface PerplPositionMarketInfo {
  symbol: string;
  name: string;
  priceDecimals: number;
  sizeDecimals?: number;
}

interface MarketState {
  lst?: number;
  mrk?: number;
  mid?: number;
  orl?: number;
  prv?: number;
}

interface MarketSubscription {
  symbol: string;
  onUpdate: (market: PerpetualMarketSnapshot) => void;
  onError?: (error: Error) => void;
}

export interface PerplPriceCandle {
  timestamp: number;
  close: number;
}

export interface PerplOrderBookLevel {
  price: number;
  size: number;
  orders?: number;
}

export interface PerplOrderBookSnapshot {
  bids: PerplOrderBookLevel[];
  asks: PerplOrderBookLevel[];
}

export interface PerplOrderBookMarket {
  id: number;
  symbol: string;
  priceDecimals: number;
  sizeDecimals: number;
}

interface NetworkRuntime {
  contextCache?: { markets: PerplMarketConfig[]; expiresAt: number };
  contextRequest?: Promise<PerplMarketConfig[]>;
  listeners: Set<MarketSubscription>;
  orderBookListeners: Set<OrderBookSubscription>;
  subscribedStreams: Set<string>;
  bookSubscriptionMarkets: Map<number, number>;
  orderBooks: Map<number, MutableOrderBook>;
  socket?: WebSocket;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
}

interface OrderBookSubscription extends PerplOrderBookMarket {
  onUpdate: (book: PerplOrderBookSnapshot) => void;
  onError?: (error: Error) => void;
}

interface ScaledOrderBookLevel {
  price: number;
  size: number;
  orders?: number;
}

interface MutableOrderBook {
  bids: Map<number, ScaledOrderBookLevel>;
  asks: Map<number, ScaledOrderBookLevel>;
}

const networkRuntime: Record<PerplNetwork, NetworkRuntime> = {
  testnet: createNetworkRuntime(),
};

export const perplMarketVenue = {
  id: "perpl",
  name: "Perpl",
  marketType: "perpetual" as const,
  fetchMarket,
  subscribeToMarket,
};

export async function getPerplPositionMarketInfo(
  marketId: number,
  network: PerplNetwork = "testnet",
): Promise<PerplPositionMarketInfo | undefined> {
  const market = (await getMarkets(network)).find(({ id }) => id === marketId);
  if (!market) return undefined;
  return {
    symbol: market.symbol,
    name: market.name,
    priceDecimals: market.priceDecimals,
    ...(market.sizeDecimals === undefined
      ? {}
      : { sizeDecimals: market.sizeDecimals }),
  };
}

export async function fetchMarket(
  symbol: string,
  network: PerplNetwork = "testnet",
): Promise<PerpetualMarketSnapshot | null> {
  const config = PERPL_NETWORKS[network];
  const market = findMarket(await getMarkets(network), symbol);
  if (!market) return null;

  const response = await fetch(
    `${config.apiUrl}/v1/market-data/${market.id}/ticker`,
  );
  const body: unknown = await readJson(response, "Perpl market ticker");
  if (!response.ok) {
    throw new Error(`Unable to load Perpl market data (${response.status}).`);
  }

  const states = readMarketStates(body);
  if (!states) return null;
  return createSnapshot(market, states[String(market.id)]);
}

export async function fetch24HourPriceHistory(
  symbol: string,
): Promise<PerplPriceCandle[]> {
  const market = findMarket(await getMarkets("testnet"), symbol);
  if (!market) return [];

  const to = Date.now();
  const from = to - HISTORY_WINDOW_MS;
  const response = await fetch(
    `${PERPL_NETWORKS.testnet.apiUrl}/v1/market-data/${market.id}/candles/${CANDLE_RESOLUTION_SECONDS}/${from}-${to}`,
  );
  const body: unknown = await readJson(response, "Perpl price history");
  if (!response.ok) {
    throw new Error(`Unable to load Perpl price history (${response.status}).`);
  }
  if (!isRecord(body) || !isUnknownArray(body.d)) {
    throw new Error("Perpl returned invalid price history.");
  }

  const scale = 10 ** market.priceDecimals;
  return body.d.flatMap((value) => {
    if (!isRecord(value)) return [];
    const timestamp = numeric(value.t);
    const close = numeric(value.c);
    return timestamp !== undefined && close !== undefined && close > 0
      ? [{ timestamp, close: close / scale }]
      : [];
  });
}

export function subscribeToMarket(
  symbol: string,
  onUpdate: (market: PerpetualMarketSnapshot) => void,
  onError?: (error: Error) => void,
  network: PerplNetwork = "testnet",
) {
  const subscription = { symbol, onUpdate, onError };
  const runtime = networkRuntime[network];
  runtime.listeners.add(subscription);
  if (runtime.socket?.readyState === WebSocket.OPEN && runtime.contextCache) {
    syncSubscriptions(network, runtime.contextCache.markets);
  } else {
    void connect(network);
  }

  return () => {
    runtime.listeners.delete(subscription);
    if (hasListeners(runtime)) {
      if (
        runtime.socket?.readyState === WebSocket.OPEN &&
        runtime.contextCache
      ) {
        syncSubscriptions(network, runtime.contextCache.markets);
      }
      return;
    }
    closeConnection(network);
  };
}

export function subscribeToOrderBook(
  market: PerplOrderBookMarket,
  onUpdate: (book: PerplOrderBookSnapshot) => void,
  onError?: (error: Error) => void,
  network: PerplNetwork = "testnet",
) {
  if (
    !Number.isSafeInteger(market.id) ||
    market.id <= 0 ||
    !isValidDecimalCount(market.priceDecimals) ||
    !isValidDecimalCount(market.sizeDecimals)
  ) {
    throw new Error("Perpl returned invalid order book market configuration.");
  }
  const subscription = { ...market, onUpdate, onError };
  const runtime = networkRuntime[network];
  runtime.orderBookListeners.add(subscription);
  const cachedBook = runtime.orderBooks.get(market.id);
  if (cachedBook) onUpdate(createOrderBookSnapshot(cachedBook, subscription));
  if (runtime.socket?.readyState === WebSocket.OPEN && runtime.contextCache) {
    syncSubscriptions(network, runtime.contextCache.markets);
  } else {
    void connect(network);
  }

  return () => {
    runtime.orderBookListeners.delete(subscription);
    if (hasListeners(runtime)) {
      if (
        runtime.socket?.readyState === WebSocket.OPEN &&
        runtime.contextCache
      ) {
        syncSubscriptions(network, runtime.contextCache.markets);
      }
      return;
    }
    closeConnection(network);
  };
}

async function connect(network: PerplNetwork) {
  const config = PERPL_NETWORKS[network];
  const runtime = networkRuntime[network];
  if (
    !hasListeners(runtime) ||
    (runtime.socket &&
      (runtime.socket.readyState === WebSocket.CONNECTING ||
        runtime.socket.readyState === WebSocket.OPEN))
  ) {
    return;
  }

  let markets: PerplMarketConfig[];
  try {
    markets = await getMarkets(network);
  } catch (cause) {
    notifyError(network, toError(cause));
    scheduleReconnect(network);
    return;
  }
  if (
    !hasListeners(runtime) ||
    (runtime.socket &&
      (runtime.socket.readyState === WebSocket.CONNECTING ||
        runtime.socket.readyState === WebSocket.OPEN))
  ) {
    return;
  }

  const connection = new WebSocket(`${config.wsUrl}/ws/v1/market-data`);
  runtime.socket = connection;
  connection.onopen = () => {
    if (runtime.socket !== connection) return;
    runtime.reconnectAttempt = 0;
    runtime.subscribedStreams.clear();
    runtime.bookSubscriptionMarkets.clear();
    runtime.orderBooks.clear();
    syncSubscriptions(network, markets);
  };
  connection.onmessage = (event) => {
    if (runtime.socket !== connection) return;
    const frame = parseFrame(event.data);
    if (handleSubscriptionResponse(network, frame)) return;
    const states = readMarketStates(frame);
    if (states) {
      for (const listener of runtime.listeners) {
        const market = findMarket(markets, listener.symbol);
        if (!market) continue;
        const snapshot = createSnapshot(market, states[String(market.id)]);
        if (snapshot) listener.onUpdate(snapshot);
      }
      return;
    }
    applyOrderBookMessage(network, frame);
  };
  connection.onerror = () => connection.close();
  connection.onclose = () => {
    if (runtime.socket !== connection) return;
    runtime.socket = undefined;
    runtime.subscribedStreams.clear();
    runtime.bookSubscriptionMarkets.clear();
    runtime.orderBooks.clear();
    notifyOrderBookError(
      network,
      new Error("Perpl order book stream disconnected. Reconnecting."),
    );
    scheduleReconnect(network);
  };
}

function syncSubscriptions(
  network: PerplNetwork,
  markets: PerplMarketConfig[],
) {
  const runtime = networkRuntime[network];
  const connection = runtime.socket;
  if (!connection || connection.readyState !== WebSocket.OPEN) return;

  const desiredStreams = new Set<string>();
  if (runtime.listeners.size > 0) {
    desiredStreams.add(`market-state@${PERPL_NETWORKS[network].chainId}`);
  }
  for (const listener of runtime.listeners) {
    if (!findMarket(markets, listener.symbol)) {
      listener.onError?.(
        new Error(`Perpl market "${listener.symbol}" is unavailable.`),
      );
    }
  }
  for (const listener of runtime.orderBookListeners) {
    if (!markets.some(({ id }) => id === listener.id)) {
      listener.onError?.(
        new Error(`Perpl market "${listener.symbol}" is unavailable.`),
      );
      continue;
    }
    desiredStreams.add(`order-book@${listener.id}`);
  }

  const subscribe = [...desiredStreams].filter(
    (stream) => !runtime.subscribedStreams.has(stream),
  );
  const unsubscribe = [...runtime.subscribedStreams].filter(
    (stream) => !desiredStreams.has(stream),
  );
  if (subscribe.length === 0 && unsubscribe.length === 0) return;

  connection.send(
    JSON.stringify({
      mt: 5,
      subs: [
        ...subscribe.map((stream) => ({ stream, subscribe: true })),
        ...unsubscribe.map((stream) => ({ stream, subscribe: false })),
      ],
    }),
  );
  runtime.subscribedStreams = desiredStreams;

  for (const stream of unsubscribe) {
    const marketId = getOrderBookMarketId(stream);
    if (marketId === undefined) continue;
    runtime.orderBooks.delete(marketId);
    for (const [sid, subscribedMarketId] of runtime.bookSubscriptionMarkets) {
      if (subscribedMarketId === marketId) {
        runtime.bookSubscriptionMarkets.delete(sid);
      }
    }
  }
}

function handleSubscriptionResponse(network: PerplNetwork, value: unknown) {
  if (!isRecord(value) || value.mt !== 6 || !isUnknownArray(value.subs)) {
    return false;
  }
  const runtime = networkRuntime[network];
  for (const subscription of value.subs) {
    if (!isRecord(subscription)) continue;
    const stream = string(subscription.stream);
    if (!stream) continue;
    const marketId = getOrderBookMarketId(stream);
    const status = isRecord(subscription.status)
      ? subscription.status
      : undefined;
    const code = status ? integer(status.code) : undefined;
    if (code !== undefined && code !== 0) {
      const reason = string(status?.error) ?? `code ${String(code)}`;
      const error = new Error(
        `Perpl market data subscription failed: ${reason}.`,
      );
      if (marketId === undefined) {
        for (const listener of runtime.listeners) {
          listener.onError?.(error);
        }
      } else {
        notifyOrderBookError(network, error, marketId);
      }
      continue;
    }
    const sid = numeric(subscription.sid);
    if (marketId !== undefined && sid !== undefined && sid > 0) {
      runtime.bookSubscriptionMarkets.set(sid, marketId);
    }
  }
  return true;
}

function applyOrderBookMessage(network: PerplNetwork, value: unknown) {
  if (!isRecord(value) || (value.mt !== 15 && value.mt !== 16)) {
    return;
  }
  const sid = numeric(value.sid);
  if (sid === undefined) return;
  const runtime = networkRuntime[network];
  const marketId = runtime.bookSubscriptionMarkets.get(sid);
  if (marketId === undefined) return;
  const listeners = [...runtime.orderBookListeners].filter(
    (listener) => listener.id === marketId,
  );
  if (listeners.length === 0) return;

  let book = runtime.orderBooks.get(marketId);
  if (value.mt === 15) {
    if (!Array.isArray(value.bid) || !Array.isArray(value.ask)) return;
    book = {
      bids: parseScaledOrderBookLevels(value.bid),
      asks: parseScaledOrderBookLevels(value.ask),
    };
    runtime.orderBooks.set(marketId, book);
  } else {
    if (!book) return;
    applyScaledOrderBookLevels(book.bids, value.bid);
    applyScaledOrderBookLevels(book.asks, value.ask);
  }

  if (!book) return;
  for (const listener of listeners) {
    listener.onUpdate(createOrderBookSnapshot(book, listener));
  }
}

function parseScaledOrderBookLevels(
  value: unknown[],
): Map<number, ScaledOrderBookLevel> {
  const levels = new Map<number, ScaledOrderBookLevel>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const price = numeric(entry.p);
    const size = numeric(entry.s);
    const orderCount = numeric(entry.o);
    if (
      price === undefined ||
      price <= 0 ||
      size === undefined ||
      size <= 0 ||
      orderCount === 0
    ) {
      continue;
    }
    levels.set(price, {
      price,
      size,
      ...(orderCount === undefined ? {} : { orders: orderCount }),
    });
  }
  return levels;
}

function applyScaledOrderBookLevels(
  levels: Map<number, ScaledOrderBookLevel>,
  value: unknown,
) {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const price = numeric(entry.p);
    const orderCount = numeric(entry.o);
    if (price === undefined || price <= 0) continue;
    if (orderCount === 0) {
      levels.delete(price);
      continue;
    }
    const size = numeric(entry.s);
    if (size === 0) {
      levels.delete(price);
      continue;
    }
    if (size === undefined || size <= 0) continue;
    levels.set(price, {
      price,
      size,
      ...(orderCount === undefined ? {} : { orders: orderCount }),
    });
  }
}

function createOrderBookSnapshot(
  book: MutableOrderBook,
  market: PerplOrderBookMarket,
): PerplOrderBookSnapshot {
  const priceScale = 10 ** market.priceDecimals;
  const sizeScale = 10 ** market.sizeDecimals;
  return {
    bids: [...book.bids.values()]
      .sort((left, right) => right.price - left.price)
      .map(({ price, size, orders }) => ({
        price: price / priceScale,
        size: size / sizeScale,
        ...(orders === undefined ? {} : { orders }),
      })),
    asks: [...book.asks.values()]
      .sort((left, right) => left.price - right.price)
      .map(({ price, size, orders }) => ({
        price: price / priceScale,
        size: size / sizeScale,
        ...(orders === undefined ? {} : { orders }),
      })),
  };
}

function getOrderBookMarketId(stream: string) {
  const match = /^order-book@(\d+)$/.exec(stream);
  const marketId = match?.[1] ? Number(match[1]) : undefined;
  return marketId !== undefined &&
    Number.isSafeInteger(marketId) &&
    marketId > 0
    ? marketId
    : undefined;
}

function notifyOrderBookError(
  network: PerplNetwork,
  error: Error,
  marketId?: number,
) {
  for (const listener of networkRuntime[network].orderBookListeners) {
    if (marketId !== undefined && listener.id !== marketId) continue;
    listener.onError?.(error);
  }
}

function hasListeners(runtime: NetworkRuntime) {
  return runtime.listeners.size > 0 || runtime.orderBookListeners.size > 0;
}

function closeConnection(network: PerplNetwork) {
  const runtime = networkRuntime[network];
  if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
  runtime.reconnectTimer = undefined;
  runtime.reconnectAttempt = 0;
  runtime.subscribedStreams.clear();
  runtime.bookSubscriptionMarkets.clear();
  runtime.orderBooks.clear();
  const connection = runtime.socket;
  runtime.socket = undefined;
  connection?.close();
}

function scheduleReconnect(network: PerplNetwork) {
  const runtime = networkRuntime[network];
  if (!hasListeners(runtime) || runtime.reconnectTimer) return;
  const delay = Math.min(1_000 * 2 ** runtime.reconnectAttempt, 30_000);
  runtime.reconnectAttempt += 1;
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = undefined;
    void connect(network);
  }, delay);
}

function notifyError(network: PerplNetwork, error: Error) {
  const runtime = networkRuntime[network];
  for (const listener of runtime.listeners) {
    listener.onError?.(error);
  }
  notifyOrderBookError(network, error);
}

async function getMarkets(
  network: PerplNetwork = "testnet",
): Promise<PerplMarketConfig[]> {
  const config = PERPL_NETWORKS[network];
  const runtime = networkRuntime[network];
  if (runtime.contextCache && runtime.contextCache.expiresAt > Date.now()) {
    return runtime.contextCache.markets;
  }
  if (runtime.contextRequest) return runtime.contextRequest;

  runtime.contextRequest = (async () => {
    const response = await fetch(`${config.apiUrl}/v1/pub/context`);
    const body: unknown = await readJson(response, "Perpl market context");
    if (!response.ok) {
      throw new Error(`Unable to load Perpl markets (${response.status}).`);
    }
    if (!isRecord(body) || !isUnknownArray(body.markets)) {
      throw new Error("Perpl returned invalid market configuration.");
    }

    const markets = body.markets.flatMap(parseMarketConfig);
    if (markets.length === 0) {
      throw new Error("Perpl did not return any available markets.");
    }
    runtime.contextCache = {
      markets,
      expiresAt: Date.now() + CONTEXT_CACHE_MS,
    };
    return markets;
  })();

  try {
    return await runtime.contextRequest;
  } finally {
    runtime.contextRequest = undefined;
  }
}

function createNetworkRuntime(): NetworkRuntime {
  return {
    listeners: new Set(),
    orderBookListeners: new Set(),
    subscribedStreams: new Set(),
    bookSubscriptionMarkets: new Map(),
    orderBooks: new Map(),
    reconnectAttempt: 0,
  };
}

function parseMarketConfig(value: unknown): PerplMarketConfig[] {
  if (!isRecord(value)) return [];
  const config = isRecord(value.config) ? value.config : value;
  const id = numeric(value.id ?? value.market_id ?? value.mkt);
  const priceDecimals = numeric(config.price_decimals ?? value.price_decimals);
  const sizeDecimals = numeric(config.size_decimals ?? value.size_decimals);
  const rawSymbol =
    string(value.symbol) ??
    string(value.ticker) ??
    string(value.base_asset) ??
    string(value.name);
  if (
    id === undefined ||
    id <= 0 ||
    priceDecimals === undefined ||
    !rawSymbol ||
    !isValidDecimalCount(priceDecimals) ||
    (sizeDecimals !== undefined && !isValidDecimalCount(sizeDecimals))
  ) {
    return [];
  }
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return [];

  return [
    {
      id,
      symbol,
      name: string(value.name) ?? `${symbol}-PERP`,
      priceDecimals,
      ...(sizeDecimals === undefined ? {} : { sizeDecimals }),
    },
  ];
}

function findMarket(markets: PerplMarketConfig[], symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return markets.find((market) => market.symbol === normalized);
}

function createSnapshot(
  market: PerplMarketConfig,
  state?: MarketState,
): PerpetualMarketSnapshot | null {
  if (!state) return null;
  const scale = 10 ** market.priceDecimals;
  const lastPrice = positive(state.lst);
  const price =
    lastPrice ??
    positive(state.mrk) ??
    positive(state.mid) ??
    positive(state.orl);
  if (price === undefined) return null;

  const markPrice = positive(state.mrk);
  const previousPrice = positive(state.prv);
  return {
    symbol: market.symbol,
    name: market.name,
    price: price / scale,
    ...(markPrice === undefined ? {} : { markPrice: markPrice / scale }),
    ...(previousPrice === undefined
      ? {}
      : { priceChange24h: ((price - previousPrice) / previousPrice) * 100 }),
  };
}

function readMarketStates(value: unknown): Record<string, MarketState> | null {
  const parsed = parseFrame(value);
  if (!isRecord(parsed) || parsed.mt !== 9 || !isRecord(parsed.d)) return null;
  const result: Record<string, MarketState> = {};
  for (const [id, state] of Object.entries(parsed.d)) {
    if (!isRecord(state)) continue;
    result[id] = {
      lst: numeric(state.lst),
      mrk: numeric(state.mrk),
      mid: numeric(state.mid),
      orl: numeric(state.orl),
      prv: numeric(state.prv),
    };
  }
  return result;
}

function parseFrame(value: unknown): unknown {
  let data = value;
  if (typeof value === "object" && value !== null && "data" in value) {
    data = value.data;
  }
  if (typeof data !== "string") return data;
  try {
    const parsed: unknown = JSON.parse(data) as unknown;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeSymbol(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[-_/](USD|USDT|USDC|PERP|PERPETUAL)$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function positive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function numeric(value: unknown) {
  const parsed = integer(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function integer(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isValidDecimalCount(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 18;
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned an invalid response.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function toError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}
