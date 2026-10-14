import { getBaseUrl } from "~/lib/utils/api";

const HYPERLIQUID_WS_URL = "wss://api.hyperliquid-testnet.xyz/ws";
const HYPERLIQUID_INFO_URL = `${getBaseUrl()}/api/hyperliquid/info`;
const REST_REQUEST_INTERVAL_MS = 100;
const MAX_RETRIES = 3;
const CACHE_DURATION_BY_TYPE: Record<string, number> = {
  allMids: 5_000,
  metaAndAssetCtxs: 30_000,
  outcomeMeta: 30_000,
};
const responseCache = new Map<
  string,
  { expiresAt: number; request: Promise<unknown> }
>();
let nextRequestAt = 0;
let requestSlotQueue = Promise.resolve();

export interface ISubscription {
  unsubscribe: () => Promise<void>;
}

interface SubscriptionEntry {
  payload: Record<string, unknown>;
  listener: (data: Record<string, unknown>) => void;
  onError?: (cause: Error) => void;
}

const entries = new Set<SubscriptionEntry>();
let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function sendSubscription(
  method: "subscribe" | "unsubscribe",
  payload: Record<string, unknown>,
) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ method, subscription: payload }));
  }
}

function matches(entry: SubscriptionEntry, data: Record<string, unknown>) {
  if (entry.payload.type !== "allMids") return true;
  return (data.dex || undefined) === (entry.payload.dex || undefined);
}

function ensureSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  const connection = new WebSocket(HYPERLIQUID_WS_URL);
  socket = connection;
  connection.onopen = () => {
    for (const entry of entries) sendSubscription("subscribe", entry.payload);
  };
  connection.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        channel?: string;
        data?: Record<string, unknown>;
      };
      if (!message.channel || !message.data) return;
      for (const entry of entries) {
        if (
          entry.payload.type === message.channel &&
          matches(entry, message.data)
        ) {
          entry.listener(message.data);
        }
      }
    } catch {
      // Ignore malformed frames.
    }
  };
  connection.onclose = () => {
    if (socket === connection) socket = undefined;
    if (entries.size === 0 || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (entries.size > 0) ensureSocket();
    }, 3_000);
  };
  connection.onerror = () => {
    for (const entry of entries) {
      entry.onError?.(new Error("Hyperliquid WebSocket error."));
    }
  };
}

function subscribe(
  payload: Record<string, unknown>,
  listener: (data: Record<string, unknown>) => void,
  options?: { onError?: (cause: Error) => void },
): Promise<ISubscription> {
  const entry: SubscriptionEntry = {
    payload,
    listener,
    onError: options?.onError,
  };
  entries.add(entry);
  ensureSocket();
  sendSubscription("subscribe", payload);
  return Promise.resolve({
    unsubscribe: () => {
      entries.delete(entry);
      sendSubscription("unsubscribe", payload);
      if (entries.size === 0) {
        socket?.close();
        socket = undefined;
      }
      return Promise.resolve();
    },
  });
}

export const hyperliquidSubscriptionClient = {
  allMids: (
    ...args:
      | [
          { dex?: string },
          (event: { dex?: string; mids: Record<string, string> }) => void,
          { onError?: (cause: Error) => void }?,
        ]
      | [
          (event: { dex?: string; mids: Record<string, string> }) => void,
          { onError?: (cause: Error) => void }?,
        ]
  ) => {
    const params = typeof args[0] === "function" ? {} : args[0];
    const listener = (
      typeof args[0] === "function" ? args[0] : args[1]
    ) as (event: { dex?: string; mids: Record<string, string> }) => void;
    const options = (typeof args[0] === "function" ? args[1] : args[2]) as
      | { onError?: (cause: Error) => void }
      | undefined;
    return subscribe(
      { type: "allMids", ...(params.dex ? { dex: params.dex } : {}) },
      (data) =>
        listener(data as { dex?: string; mids: Record<string, string> }),
      options,
    );
  },
  outcomeMetaUpdates: (
    listener: () => void,
    options?: { onError?: (cause: Error) => void },
  ) => subscribe({ type: "outcomeMetaUpdates" }, () => listener(), options),
};

export async function requestHyperliquidInfo<T>(payload: object): Promise<T> {
  const requestKey = JSON.stringify(payload);
  const cacheDuration =
    "type" in payload && typeof payload.type === "string"
      ? CACHE_DURATION_BY_TYPE[payload.type]
      : undefined;
  const cached = responseCache.get(requestKey);
  if (cached && cached.expiresAt > Date.now()) {
    return (await cached.request) as T;
  }

  const request = fetchHyperliquidInfo(payload);
  if (cacheDuration) {
    responseCache.set(requestKey, {
      expiresAt: Date.now() + cacheDuration,
      request,
    });
  }
  try {
    return (await request) as T;
  } catch (cause) {
    if (responseCache.get(requestKey)?.request === request) {
      responseCache.delete(requestKey);
    }
    throw cause;
  }
}

async function fetchHyperliquidInfo(payload: object): Promise<unknown> {
  let attempt = 0;
  while (true) {
    await waitForRequestSlot();
    let response: Response;
    try {
      response = await fetch(HYPERLIQUID_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      if (!(cause instanceof TypeError) || attempt >= MAX_RETRIES) {
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
      await delay(1_000 * 2 ** attempt);
      attempt += 1;
      continue;
    }

    if (
      (response.status === 429 ||
        response.status === 408 ||
        response.status >= 500) &&
      attempt < MAX_RETRIES
    ) {
      const retryDelay =
        getRetryDelay(response) ?? Math.min(1_000 * 2 ** attempt, 8_000);
      if (response.status === 429) {
        nextRequestAt = Math.max(nextRequestAt, Date.now() + retryDelay);
      }
      await delay(retryDelay);
      attempt += 1;
      continue;
    }
    if (!response.ok) {
      throw new Error(`Hyperliquid info request failed (${response.status}).`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error("Hyperliquid returned an invalid info response.");
    }
  }
}

async function waitForRequestSlot() {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousTurn = requestSlotQueue;
  requestSlotQueue = turn;
  await previousTurn;
  try {
    const waitTime = Math.max(nextRequestAt - Date.now(), 0);
    if (waitTime > 0) await delay(waitTime);
    nextRequestAt = Date.now() + REST_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

function getRetryDelay(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1_000, 0);
  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? undefined : Math.max(retryAt - Date.now(), 0);
}

function delay(duration: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, duration));
}
