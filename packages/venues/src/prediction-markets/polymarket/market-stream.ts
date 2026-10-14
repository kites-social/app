import { type PredictionEventSnapshot } from "../../types";

export interface PolymarketStreamEvent {
  snapshot: PredictionEventSnapshot;
  assetOutcomes: Map<string, { marketSlug: string; outcome: "yes" | "no" }>;
}

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderBookSnapshot {
  bids: PolymarketOrderBookLevel[];
  asks: PolymarketOrderBookLevel[];
}

type EventLoader = (slug: string) => Promise<PolymarketStreamEvent>;
type UpdateListener = (event: PredictionEventSnapshot) => void;
type ErrorListener = (error: Error) => void;
interface OrderBookListener {
  onUpdate: (book: PolymarketOrderBookSnapshot) => void;
  onError?: ErrorListener;
}

interface StreamListener {
  onUpdate: UpdateListener;
  onError?: ErrorListener;
  marketSlug?: string;
}

interface EventSubscription {
  listeners: Set<StreamListener>;
  snapshot?: PredictionEventSnapshot;
  assetOutcomes: Map<string, { marketSlug: string; outcome: "yes" | "no" }>;
  livePrices: Map<string, number>;
  retryAttempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface StoredBookLevel extends PolymarketOrderBookLevel {
  numericPrice: number;
  numericSize: number;
}

interface MutableOrderBook {
  bids: Map<string, StoredBookLevel>;
  asks: Map<string, StoredBookLevel>;
}

interface PriceChange {
  assetId: string;
  price: number;
}

export function createPolymarketMarketStream(loadEvent: EventLoader) {
  const events = new Map<string, EventSubscription>();
  const orderBookListeners = new Map<string, Set<OrderBookListener>>();
  const orderBooks = new Map<string, MutableOrderBook>();
  let socket: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let subscribedAssets = new Set<string>();

  function allAssetIds(): Set<string> {
    const ids = new Set<string>();
    for (const event of events.values()) {
      if (event.listeners.size === 0) continue;
      for (const [id, outcome] of event.assetOutcomes) {
        if (
          [...event.listeners].some(
            (listener) =>
              listener.marketSlug === undefined ||
              listener.marketSlug === outcome.marketSlug,
          )
        ) {
          ids.add(id);
        }
      }
    }
    for (const assetId of orderBookListeners.keys()) {
      ids.add(assetId);
    }
    return ids;
  }

  function syncSubscriptions() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const desiredAssets = allAssetIds();
    const subscribe = [...desiredAssets].filter(
      (assetId) => !subscribedAssets.has(assetId),
    );
    const unsubscribe = [...subscribedAssets].filter(
      (assetId) => !desiredAssets.has(assetId),
    );

    if (subscribe.length > 0) {
      socket.send(
        JSON.stringify({
          operation: "subscribe",
          assets_ids: subscribe,
          custom_feature_enabled: true,
        }),
      );
      subscribe.forEach((assetId) => subscribedAssets.add(assetId));
    }
    if (unsubscribe.length > 0) {
      socket.send(
        JSON.stringify({ operation: "unsubscribe", assets_ids: unsubscribe }),
      );
      unsubscribe.forEach((assetId) => subscribedAssets.delete(assetId));
    }
  }

  function connect() {
    if (
      allAssetIds().size === 0 ||
      (socket &&
        (socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN))
    ) {
      return;
    }

    const connection = new WebSocket(
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    socket = connection;
    connection.onopen = () => {
      if (socket !== connection) return;
      reconnectAttempt = 0;
      subscribedAssets = new Set();
      const assets = [...allAssetIds()];
      if (assets.length === 0) {
        connection.close();
        return;
      }
      connection.send(
        JSON.stringify({
          assets_ids: assets,
          custom_feature_enabled: true,
          type: "market",
        }),
      );
      assets.forEach((assetId) => subscribedAssets.add(assetId));
      heartbeat = setInterval(() => {
        if (connection.readyState === WebSocket.OPEN) {
          connection.send("PING");
        }
      }, 10_000);
    };
    connection.onmessage = (message) => {
      applyOrderBookChanges(message.data);
      applyPriceChanges(message.data);
    };
    connection.onclose = () => {
      if (socket !== connection) return;
      socket = undefined;
      subscribedAssets.clear();
      orderBooks.clear();
      clearHeartbeat();
      notifyOrderBookError(
        new Error("Polymarket market data disconnected. Reconnecting."),
      );
      scheduleReconnect();
    };
    connection.onerror = () => connection.close();
  }

  function clearHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function scheduleReconnect() {
    if (allAssetIds().size === 0 || reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function applyEvent(
    subscription: EventSubscription,
    data: PolymarketStreamEvent,
  ) {
    const previousAssets = new Set(subscription.assetOutcomes.keys());
    subscription.assetOutcomes = data.assetOutcomes;
    for (const assetId of subscription.livePrices.keys()) {
      if (!subscription.assetOutcomes.has(assetId)) {
        subscription.livePrices.delete(assetId);
      }
    }
    subscription.snapshot = mergeLivePrices(
      data.snapshot,
      subscription.assetOutcomes,
      subscription.livePrices,
    );
    subscription.retryAttempt = 0;
    notify(subscription);

    if (socket?.readyState === WebSocket.OPEN) {
      const desiredAssets = allAssetIds();
      const removedAssets = [...previousAssets].filter(
        (assetId) => !desiredAssets.has(assetId),
      );
      if (removedAssets.length > 0) {
        socket.send(
          JSON.stringify({
            operation: "unsubscribe",
            assets_ids: removedAssets,
          }),
        );
        removedAssets.forEach((assetId) => subscribedAssets.delete(assetId));
      }
      syncSubscriptions();
    } else {
      connect();
    }
  }

  function notify(subscription: EventSubscription) {
    if (!subscription.snapshot) return;
    for (const listener of subscription.listeners) {
      listener.onUpdate(subscription.snapshot);
    }
  }

  function notifyOrderBook(assetId: string) {
    const book = orderBooks.get(assetId);
    const listeners = orderBookListeners.get(assetId);
    if (!book || !listeners) return;
    const snapshot = toOrderBookSnapshot(book);
    for (const listener of listeners) {
      listener.onUpdate(snapshot);
    }
  }

  function notifyOrderBookError(error: Error, assetId?: string) {
    if (assetId) {
      for (const listener of orderBookListeners.get(assetId) ?? []) {
        listener.onError?.(error);
      }
      return;
    }
    for (const group of orderBookListeners.values()) {
      for (const listener of group) {
        listener.onError?.(error);
      }
    }
  }

  function closeWhenIdle() {
    if (allAssetIds().size > 0) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearHeartbeat();
    const connection = socket;
    socket = undefined;
    subscribedAssets.clear();
    connection?.close();
  }

  async function load(slug: string, subscription: EventSubscription) {
    try {
      const data = await loadEvent(slug);
      if (events.get(slug) !== subscription) return;
      applyEvent(subscription, data);
    } catch (cause) {
      if (events.get(slug) !== subscription) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const listener of subscription.listeners) {
        listener.onError?.(error);
      }
      scheduleEventRetry(slug, subscription);
      throw error;
    }
  }

  function scheduleEventRetry(slug: string, subscription: EventSubscription) {
    if (subscription.retryTimer) return;
    const delay = Math.min(1_000 * 2 ** subscription.retryAttempt, 30_000);
    subscription.retryAttempt += 1;
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = undefined;
      if (events.get(slug) === subscription) {
        void load(slug, subscription).catch(() => undefined);
      }
    }, delay);
  }

  function applyPriceChanges(data: MessageEvent["data"]) {
    const changes = parsePriceChanges(data);
    if (changes.length === 0) return;

    const updates = new Map<
      EventSubscription,
      Map<string, { yes?: number; no?: number }>
    >();
    for (const subscription of events.values()) {
      if (!subscription.snapshot) continue;
      for (const change of changes) {
        const outcome = subscription.assetOutcomes.get(change.assetId);
        if (!outcome) continue;
        subscription.livePrices.set(change.assetId, change.price * 100);
        let marketUpdate = updates.get(subscription);
        if (!marketUpdate) {
          marketUpdate = new Map();
          updates.set(subscription, marketUpdate);
        }
        const probabilities = marketUpdate.get(outcome.marketSlug) ?? {};
        probabilities[outcome.outcome] = change.price * 100;
        marketUpdate.set(outcome.marketSlug, probabilities);
      }
      if (updates.has(subscription)) {
        const marketUpdates = updates.get(subscription);
        subscription.snapshot = {
          ...subscription.snapshot,
          markets: subscription.snapshot.markets.map((market) => {
            const update = marketUpdates?.get(market.slug);
            return update
              ? {
                  ...market,
                  ...(update.yes === undefined
                    ? {}
                    : { yesProbability: update.yes }),
                  ...(update.no === undefined
                    ? {}
                    : { noProbability: update.no }),
                }
              : market;
          }),
        };
      }
    }

    for (const [subscription] of updates) {
      const snapshot = subscription.snapshot;
      if (!snapshot) continue;
      for (const listener of subscription.listeners) {
        listener.onUpdate(snapshot);
      }
    }
  }

  function subscribe(
    slug: string,
    onUpdate: UpdateListener,
    onError?: ErrorListener,
    marketSlug?: string,
  ) {
    let subscription = events.get(slug);
    const isNewSubscription = !subscription;
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        assetOutcomes: new Map(),
        livePrices: new Map(),
        retryAttempt: 0,
      };
      events.set(slug, subscription);
    }
    const listener = { onUpdate, onError, marketSlug };
    subscription.listeners.add(listener);
    if (subscription.snapshot) onUpdate(subscription.snapshot);

    if (isNewSubscription) {
      void load(slug, subscription).catch(() => undefined);
    }
    if (socket?.readyState === WebSocket.OPEN) {
      syncSubscriptions();
    } else {
      connect();
    }

    return () => {
      const activeSubscription = events.get(slug);
      if (!activeSubscription) return;
      activeSubscription.listeners.delete(listener);
      if (activeSubscription.listeners.size > 0) return;

      if (activeSubscription.retryTimer) {
        clearTimeout(activeSubscription.retryTimer);
      }
      events.delete(slug);
      syncSubscriptions();
      closeWhenIdle();
    };
  }

  function subscribeToOrderBook(
    assetId: string,
    onUpdate: (book: PolymarketOrderBookSnapshot) => void,
    onError?: ErrorListener,
  ) {
    if (!/^\d+$/.test(assetId)) {
      throw new Error("Polymarket returned an invalid outcome token.");
    }
    const listener = { onUpdate, onError };
    let listeners = orderBookListeners.get(assetId);
    const isFirstListener = !listeners || listeners.size === 0;
    const wasSubscribed =
      socket?.readyState === WebSocket.OPEN && subscribedAssets.has(assetId);
    const hasSnapshot = orderBooks.has(assetId);
    if (!listeners) {
      listeners = new Set();
      orderBookListeners.set(assetId, listeners);
    }
    listeners.add(listener);

    const cachedBook = orderBooks.get(assetId);
    if (cachedBook) onUpdate(toOrderBookSnapshot(cachedBook));
    if (socket?.readyState === WebSocket.OPEN) {
      syncSubscriptions();
      if (isFirstListener && wasSubscribed && !hasSnapshot) {
        const connection = socket;
        if (connection?.readyState === WebSocket.OPEN) {
          connection.send(
            JSON.stringify({
              operation: "unsubscribe",
              assets_ids: [assetId],
            }),
          );
          subscribedAssets.delete(assetId);
          connection.send(
            JSON.stringify({
              operation: "subscribe",
              assets_ids: [assetId],
              custom_feature_enabled: true,
            }),
          );
          subscribedAssets.add(assetId);
        }
      }
    } else {
      void connect();
    }

    return () => {
      const activeListeners = orderBookListeners.get(assetId);
      if (!activeListeners) return;
      activeListeners.delete(listener);
      if (activeListeners.size === 0) {
        orderBookListeners.delete(assetId);
        orderBooks.delete(assetId);
      }
      syncSubscriptions();
      closeWhenIdle();
    };
  }

  function applyOrderBookChanges(data: MessageEvent["data"]) {
    const messages = parseMessages(data);
    const changedAssets = new Set<string>();

    for (const value of messages) {
      if (!isRecord(value)) continue;
      const payload = isRecord(value.payload) ? value.payload : value;
      const type = value.type ?? value.event_type;

      if (type === "book") {
        const assetId = readString(payload.asset_id ?? payload.assetId);
        if (
          !assetId ||
          !orderBookListeners.has(assetId) ||
          !Array.isArray(payload.bids) ||
          !Array.isArray(payload.asks)
        ) {
          continue;
        }
        orderBooks.set(assetId, {
          bids: parseOrderBookLevels(payload.bids),
          asks: parseOrderBookLevels(payload.asks),
        });
        changedAssets.add(assetId);
        continue;
      }

      const priceChanges = readPriceChanges(value, payload);
      if (!priceChanges) continue;
      for (const change of priceChanges) {
        if (!isRecord(change)) continue;
        const assetId = readString(change.asset_id ?? change.assetId);
        if (!assetId || !orderBookListeners.has(assetId)) continue;
        const book = orderBooks.get(assetId);
        const level = parseOrderBookLevel(change.price, change.size);
        const side = readString(change.side)?.toUpperCase();
        if (!book || !level || level.numericPrice <= 0) continue;
        const levels =
          side === "BUY" || side === "BID"
            ? book.bids
            : side === "SELL" || side === "ASK"
              ? book.asks
              : undefined;
        if (!levels) continue;
        const key = String(level.numericPrice);
        if (level.numericSize === 0) {
          levels.delete(key);
        } else {
          levels.set(key, level);
        }
        changedAssets.add(assetId);
      }
    }

    for (const assetId of changedAssets) {
      notifyOrderBook(assetId);
    }
  }

  async function refresh(slug: string) {
    const subscription = events.get(slug);
    const data = await loadEvent(slug);
    if (subscription && events.get(slug) === subscription) {
      applyEvent(subscription, data);
    }
    return data.snapshot;
  }

  return { refresh, subscribe, subscribeToOrderBook };
}

function parsePriceChanges(data: MessageEvent["data"]): PriceChange[] {
  const messages = parseMessages(data);
  const changes: PriceChange[] = [];
  for (const value of messages) {
    if (!isRecord(value)) continue;
    const payload = isRecord(value.payload) ? value.payload : value;
    const type = value.type ?? value.event_type;
    if (type === "last_trade_price") {
      addPrice(changes, payload.asset_id ?? payload.assetId, payload.price);
      continue;
    }
    if (type === "book") {
      const bestBid = getBestBookPrice(payload.bids, "bid");
      const bestAsk = getBestBookPrice(payload.asks, "ask");
      if (bestBid !== undefined && bestAsk !== undefined) {
        addMidpoint(
          changes,
          payload.asset_id ?? payload.assetId,
          bestBid,
          bestAsk,
        );
      }
      continue;
    }
    if (type === "best_bid_ask") {
      addMidpoint(
        changes,
        payload.asset_id ?? payload.assetId,
        payload.best_bid ?? payload.bestBid,
        payload.best_ask ?? payload.bestAsk,
      );
      continue;
    }

    const priceChanges = Array.isArray(payload.price_changes)
      ? payload.price_changes
      : Array.isArray(payload.priceChanges)
        ? payload.priceChanges
        : Array.isArray(value.price_changes)
          ? value.price_changes
          : null;
    if (priceChanges) {
      for (const change of priceChanges) {
        if (!isRecord(change)) continue;
        addMidpoint(
          changes,
          change.asset_id ?? change.assetId,
          change.best_bid ?? change.bestBid,
          change.best_ask ?? change.bestAsk,
        );
      }
      continue;
    }
  }
  return changes;
}

function parseMessages(data: MessageEvent["data"]): unknown[] {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function readPriceChanges(
  value: Record<string, unknown>,
  payload: Record<string, unknown>,
): unknown[] | null {
  return Array.isArray(payload.price_changes)
    ? payload.price_changes
    : Array.isArray(payload.priceChanges)
      ? payload.priceChanges
      : Array.isArray(value.price_changes)
        ? value.price_changes
        : null;
}

function parseOrderBookLevels(value: unknown[]): Map<string, StoredBookLevel> {
  const levels = new Map<string, StoredBookLevel>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const level = parseOrderBookLevel(entry.price, entry.size);
    if (!level || level.numericPrice <= 0 || level.numericSize <= 0) continue;
    levels.set(String(level.numericPrice), level);
  }
  return levels;
}

function parseOrderBookLevel(
  price: unknown,
  size: unknown,
): StoredBookLevel | null {
  const numericPrice = readDecimal(price);
  const numericSize = readDecimal(size);
  if (
    numericPrice === undefined ||
    numericPrice <= 0 ||
    numericPrice > 1 ||
    numericSize === undefined ||
    numericSize < 0
  ) {
    return null;
  }
  return {
    price: typeof price === "string" ? price : String(price),
    size: typeof size === "string" ? size : String(size),
    numericPrice,
    numericSize,
  };
}

function toOrderBookSnapshot(
  book: MutableOrderBook,
): PolymarketOrderBookSnapshot {
  return {
    bids: [...book.bids.values()]
      .sort((left, right) => right.numericPrice - left.numericPrice)
      .map(({ price, size }) => ({ price, size })),
    asks: [...book.asks.values()]
      .sort((left, right) => left.numericPrice - right.numericPrice)
      .map(({ price, size }) => ({ price, size })),
  };
}

function getBestBookPrice(value: unknown, side: "bid" | "ask") {
  if (!Array.isArray(value)) return undefined;
  let bestPrice: number | undefined;
  for (const level of value) {
    if (!isRecord(level)) continue;
    const price = readDecimal(level.price);
    if (price === undefined || price < 0 || price > 1) continue;
    if (
      bestPrice === undefined ||
      (side === "bid" ? price > bestPrice : price < bestPrice)
    ) {
      bestPrice = price;
    }
  }
  return bestPrice;
}

function readDecimal(value: unknown) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function addMidpoint(
  changes: PriceChange[],
  assetId: unknown,
  bid: unknown,
  ask: unknown,
) {
  if (
    (typeof bid !== "string" && typeof bid !== "number") ||
    (typeof ask !== "string" && typeof ask !== "number") ||
    (typeof bid === "string" && bid.trim() === "") ||
    (typeof ask === "string" && ask.trim() === "")
  ) {
    return;
  }
  const numericBid = Number(bid);
  const numericAsk = Number(ask);
  if (
    typeof assetId === "string" &&
    Number.isFinite(numericBid) &&
    Number.isFinite(numericAsk) &&
    numericBid >= 0 &&
    numericBid <= 1 &&
    numericAsk >= 0 &&
    numericAsk <= 1 &&
    numericAsk >= numericBid
  ) {
    changes.push({ assetId, price: (numericBid + numericAsk) / 2 });
  }
}

function addPrice(changes: PriceChange[], assetId: unknown, price: unknown) {
  if (
    typeof assetId !== "string" ||
    (typeof price !== "string" && typeof price !== "number") ||
    (typeof price === "string" && price.trim() === "")
  ) {
    return;
  }
  const numericPrice = Number(price);
  if (Number.isFinite(numericPrice) && numericPrice >= 0 && numericPrice <= 1) {
    changes.push({ assetId, price: numericPrice });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mergeLivePrices(
  snapshot: PredictionEventSnapshot,
  assetOutcomes: Map<string, { marketSlug: string; outcome: "yes" | "no" }>,
  livePrices: Map<string, number>,
): PredictionEventSnapshot {
  const priceUpdates = new Map<string, { yes?: number; no?: number }>();
  for (const [assetId, price] of livePrices) {
    const outcome = assetOutcomes.get(assetId);
    if (!outcome) continue;
    const update = priceUpdates.get(outcome.marketSlug) ?? {};
    update[outcome.outcome] = price;
    priceUpdates.set(outcome.marketSlug, update);
  }
  return {
    ...snapshot,
    markets: snapshot.markets.map((market) => {
      const update = priceUpdates.get(market.slug);
      return update ? { ...market, ...probabilityUpdate(update) } : market;
    }),
  };
}

function probabilityUpdate(update: { yes?: number; no?: number }) {
  return {
    ...(update.yes === undefined ? {} : { yesProbability: update.yes }),
    ...(update.no === undefined ? {} : { noProbability: update.no }),
  };
}
