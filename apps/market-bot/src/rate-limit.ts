const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FALLBACK_RETRY_MS = 5 * MINUTE;

interface RateLimitPolicy {
  name: string;
  limit: number;
  windowMs: number;
}

interface UsageEvent {
  at: number;
  amount: number;
}

interface BucketCheck {
  key: string;
  events: UsageEvent[];
  retryAt: number;
}

export class MarketBotRateLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number, message: string) {
    super(message);
    this.name = "MarketBotRateLimitError";
    this.retryAt = retryAt;
  }
}

const usage = new Map<string, UsageEvent[]>();
const serviceCooldowns = new Map<string, number>();

const requestPolicies: RateLimitPolicy[] = [
  { name: "requests", limit: 3_000, windowMs: 5 * MINUTE },
];
const sessionPolicies: RateLimitPolicy[] = [
  { name: "sessions-short", limit: 30, windowMs: 5 * MINUTE },
  { name: "sessions-daily", limit: 300, windowMs: DAY },
];
const repoWritePolicies: RateLimitPolicy[] = [
  { name: "repo-write-hourly", limit: 5_000, windowMs: HOUR },
  { name: "repo-write-daily", limit: 35_000, windowMs: DAY },
];

export function createRateLimitedFetch(service: string): typeof fetch {
  const serviceKey = getServiceKey(service);

  return async (input, init) => {
    ensureServiceAvailable(serviceKey);
    consume(
      serviceKey,
      1,
      requestPolicies,
      serviceKey,
      "Bluesky API request limit reached",
    );

    const response = await fetch(input, init);
    if (response.status === 429) {
      deferFromHeaders(serviceKey, response.headers, FALLBACK_RETRY_MS);
    }
    return response;
  };
}

export function reserveSessionAttempt(service: string, identifier: string): void {
  const serviceKey = getServiceKey(service);
  ensureServiceAvailable(serviceKey);
  consume(
    `${serviceKey}:session:${identifier.toLowerCase()}`,
    1,
    sessionPolicies,
    serviceKey,
    "Bluesky session creation limit reached",
  );
}

export function reserveRepoWrite(service: string, account: string): void {
  const serviceKey = getServiceKey(service);
  ensureServiceAvailable(serviceKey);
  // putRecord can create (3 points) or update (2 points); reserve the higher cost.
  consume(
    `${serviceKey}:repo:${account.toLowerCase()}`,
    3,
    repoWritePolicies,
    serviceKey,
    "Bluesky repository write limit reached",
  );
}

export function publisherCooldownMs(service: string): number {
  const serviceKey = getServiceKey(service);
  const retryAt = serviceCooldowns.get(serviceKey) ?? 0;
  if (retryAt <= Date.now()) {
    serviceCooldowns.delete(serviceKey);
    return 0;
  }
  return retryAt - Date.now();
}

export function normalizeAtprotoError(
  cause: unknown,
  service: string,
): Error {
  if (cause instanceof MarketBotRateLimitError) return cause;
  const nestedCause = getObjectProperty(cause, "cause");
  if (nestedCause instanceof MarketBotRateLimitError) return nestedCause;

  const error = cause instanceof Error ? cause : new Error(String(cause));
  const status = getNumericProperty(cause, "status");
  if (status !== 429) return error;

  const retryAt = deferFromHeaders(
    getServiceKey(service),
    getObjectProperty(cause, "headers"),
    FALLBACK_RETRY_MS,
  );
  return new MarketBotRateLimitError(
    retryAt,
    `${error.message}; retry after ${new Date(retryAt).toISOString()}`,
  );
}

export function isMarketBotRateLimitError(
  error: unknown,
): error is MarketBotRateLimitError {
  return error instanceof MarketBotRateLimitError;
}

function consume(
  key: string,
  amount: number,
  policies: readonly RateLimitPolicy[],
  serviceKey: string,
  label: string,
): void {
  const now = Date.now();
  const checks = policies.map((policy) => checkBucket(key, amount, policy, now));
  const retryAt = Math.max(...checks.map((check) => check.retryAt));

  if (retryAt > now) {
    deferUntil(serviceKey, retryAt);
    throw new MarketBotRateLimitError(
      retryAt,
      `${label}; retry after ${new Date(retryAt).toISOString()}`,
    );
  }

  for (const check of checks) {
    check.events.push({ at: now, amount });
    usage.set(check.key, check.events);
  }
}

function checkBucket(
  key: string,
  amount: number,
  policy: RateLimitPolicy,
  now: number,
): BucketCheck {
  const bucketKey = `${key}:${policy.name}`;
  const cutoff = now - policy.windowMs;
  const events = (usage.get(bucketKey) ?? []).filter((event) => event.at > cutoff);
  const spent = events.reduce((total, event) => total + event.amount, 0);
  if (spent + amount <= policy.limit) {
    return { key: bucketKey, events, retryAt: now };
  }

  let pointsToFree = spent + amount - policy.limit;
  let retryAt = now;
  for (const event of events) {
    pointsToFree -= event.amount;
    if (pointsToFree <= 0) {
      retryAt = event.at + policy.windowMs;
      break;
    }
  }
  return { key: bucketKey, events, retryAt };
}

function ensureServiceAvailable(serviceKey: string): void {
  const retryAt = serviceCooldowns.get(serviceKey) ?? 0;
  if (retryAt > Date.now()) {
    throw new MarketBotRateLimitError(
      retryAt,
      `Bluesky rate limit cooldown; retry after ${new Date(retryAt).toISOString()}`,
    );
  }
}

function deferFromHeaders(
  serviceKey: string,
  headers: unknown,
  fallbackMs: number,
): number {
  const retryAfter = getHeader(headers, "retry-after");
  const reset = getHeader(headers, "ratelimit-reset");
  const now = Date.now();
  const retryAfterAt = retryAfter ? parseRetryAfter(retryAfter, now) : 0;
  const resetAt = reset ? parseReset(reset, now) : 0;
  const serverRetryAt = Math.max(retryAfterAt, resetAt);
  const retryAt = serverRetryAt > now ? serverRetryAt : now + fallbackMs;
  deferUntil(serviceKey, retryAt);
  return retryAt;
}

function deferUntil(serviceKey: string, retryAt: number): void {
  serviceCooldowns.set(
    serviceKey,
    Math.max(serviceCooldowns.get(serviceKey) ?? 0, retryAt),
  );
}

function parseRetryAfter(value: string, now: number): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + seconds * 1_000;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function parseReset(value: string, now: number): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1_000;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp > now ? timestamp : 0;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers !== "object" || headers === null) return undefined;
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

function getNumericProperty(value: unknown, key: string): number | undefined {
  const property = getObjectProperty(value, key);
  return typeof property === "number" ? property : undefined;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function getServiceKey(service: string): string {
  try {
    return new URL(service).origin;
  } catch {
    return service;
  }
}
