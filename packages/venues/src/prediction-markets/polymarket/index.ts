import {
  type PredictionEventSnapshot,
  type PredictionMarketSnapshot,
  type PredictionMarketVenue,
} from "../../types";
import { POLYMARKET_VENUE_ID } from "./links";
import { createPolymarketMarketStream } from "./market-stream";

const GAMMA_API = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 100;
const pendingEventRequests = new Map<string, Promise<GammaEvent>>();

interface GammaMarket {
  slug?: string | null;
  question?: string | null;
  image?: string | null;
  icon?: string | null;
  outcomes?: string | string[] | null;
  outcomePrices?: string | string[] | null;
  clobTokenIds?: string | string[] | null;
  positionIds?: string | string[] | null;
  version?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  resolved?: boolean | null;
  umaResolutionStatus?: string | null;
}

export interface PolymarketEvent {
  id: string;
  createdAt: string | null;
  slug: string | null;
  title: string | null;
  description: string | null;
  state: { active: boolean; closed: boolean };
  markets: {
    slug: string | null;
    question: string | null;
    state: { active: boolean; closed: boolean };
    outcomes: {
      yes: { label: string; price: number | null };
      no: { label: string; price: number | null };
    };
  }[];
}

interface GammaEvent {
  id?: string | number;
  createdAt?: string | null;
  slug?: string | null;
  title?: string | null;
  image?: string | null;
  icon?: string | null;
  description?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  markets?: GammaMarket[] | null;
}

interface GammaEventKeysetPage {
  events: GammaEvent[];
  next_cursor?: string | null;
}

export interface PolymarketEventPage {
  items: PolymarketEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  limitReached: false;
}

export type PolymarketPageCursor = string;

const marketStream = createPolymarketMarketStream(async (slug) => {
  const event = await fetchGammaEvent(slug);
  return {
    snapshot: mapEventSnapshot(event),
    assetOutcomes: getAssetOutcomes(event),
  };
});

export const polymarketVenue: PredictionMarketVenue & {
  listEventsPage: (
    cursor?: PolymarketPageCursor,
  ) => Promise<PolymarketEventPage>;
  refreshEvent: (slug: string) => Promise<PredictionEventSnapshot>;
} = {
  id: POLYMARKET_VENUE_ID,
  name: "Polymarket",
  marketType: "prediction",
  fetchEvent: fetchPolymarketEvent,
  listEventsPage: fetchPolymarketEventsPage,
  refreshEvent: marketStream.refresh,
  subscribeToEvent: subscribeToPolymarketEvent,
};

export { parsePolymarketEventUrl, POLYMARKET_VENUE_ID } from "./links";
export type { PolymarketOrderBookSnapshot } from "./market-stream";

export async function fetchPolymarketEvent(
  slug: string,
): Promise<PredictionEventSnapshot> {
  const event = await fetchGammaEvent(slug);
  return mapEventSnapshot(event);
}

export async function fetchPolymarketEventsPage(
  cursor?: PolymarketPageCursor,
): Promise<PolymarketEventPage> {
  const url = new URL(`${GAMMA_API}/events/keyset`);
  url.searchParams.set("order", "createdAt");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (cursor) url.searchParams.set("after_cursor", cursor);

  const page = await fetchJson<GammaEventKeysetPage>(url);
  const items = page.events.map(mapBotEvent);
  const nextCursor = page.next_cursor || null;
  return {
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    limitReached: false,
  };
}

export function subscribeToPolymarketEvent(
  slug: string,
  onUpdate: (event: PredictionEventSnapshot) => void,
  onError?: (error: Error) => void,
  marketSlug?: string,
): () => void {
  return marketStream.subscribe(slug, onUpdate, onError, marketSlug);
}

export const refreshPolymarketEvent = marketStream.refresh;
export const subscribeToPolymarketOrderBook = marketStream.subscribeToOrderBook;

export function isRetryablePolymarketError(error: unknown): boolean {
  return error instanceof PolymarketApiError
    ? error.status === 408 || error.status === 429 || error.status >= 500
    : error instanceof TypeError;
}

export function sortPolymarketMarkets(markets: PredictionMarketSnapshot[]) {
  const sortOrder = (market: PredictionMarketSnapshot) =>
    !market.isClosed && !market.isResolved ? 0 : market.isResolved ? 2 : 1;

  return markets
    .slice()
    .sort((left, right) => sortOrder(left) - sortOrder(right));
}

class PolymarketApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PolymarketApiError";
  }
}

async function fetchGammaEvent(slug: string): Promise<GammaEvent> {
  const pendingRequest = pendingEventRequests.get(slug);
  if (pendingRequest) return pendingRequest;

  const url = new URL(`${GAMMA_API}/events`);
  url.searchParams.set("slug", slug);
  const request = fetchJson<GammaEvent[]>(url).then((events) => {
    const event = events[0];
    if (!event) throw new Error(`Polymarket event not found: ${slug}`);
    return event;
  });
  pendingEventRequests.set(slug, request);
  try {
    return await request;
  } finally {
    if (pendingEventRequests.get(slug) === request) {
      pendingEventRequests.delete(slug);
    }
  }
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new PolymarketApiError(
      `Polymarket API request failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

function mapEventSnapshot(event: GammaEvent): PredictionEventSnapshot {
  const markets = (event.markets ?? []).flatMap((market) => {
    const labels = parseStringArray(market.outcomes);
    const prices = parseStringArray(market.outcomePrices);
    const yesIndex = labels.findIndex((label) => label.toLowerCase() === "yes");
    const noIndex = labels.findIndex((label) => label.toLowerCase() === "no");
    const yesProbability = parseProbability(prices[yesIndex]);
    const noProbability = parseProbability(prices[noIndex]);
    const isResolved = isGammaMarketResolved(market);
    if (yesIndex < 0 || noIndex < 0) {
      return [];
    }
    const assetIds =
      market.version === "v2"
        ? parseStringArray(market.positionIds)
        : parseStringArray(market.clobTokenIds);

    const isClosed =
      isResolved || market.closed === true || market.active === false;
    const winningOutcome: PredictionMarketSnapshot["winningOutcome"] =
      isResolved && yesProbability !== null && noProbability !== null
        ? yesProbability >= 99.99 && noProbability <= 0.01
          ? "yes"
          : noProbability >= 99.99 && yesProbability <= 0.01
            ? "no"
            : "void"
        : null;

    return [
      {
        slug: market.slug ?? "",
        question: market.question?.trim() || event.title || "Prediction market",
        positionSystem:
          market.version === "v2" ? ("protocol-v2" as const) : ("ctf" as const),
        ...getImageUrl(market.icon, market.image),
        yesProbability,
        noProbability,
        ...(assetIds[yesIndex] ? { yesAssetId: assetIds[yesIndex] } : {}),
        ...(assetIds[noIndex] ? { noAssetId: assetIds[noIndex] } : {}),
        isClosed,
        isResolved,
        winningOutcome,
      },
    ];
  });
  return {
    title: event.title?.trim() || event.slug || "Polymarket event",
    ...getImageUrl(event.icon, event.image),
    hasResolvedMarkets: (event.markets ?? []).some(isGammaMarketResolved),
    markets,
  };
}

function isGammaMarketResolved(market: GammaMarket): boolean {
  return (
    market.resolved === true ||
    market.umaResolutionStatus?.toLowerCase() === "resolved" ||
    market.umaResolutionStatus?.toLowerCase() === "settled"
  );
}

function getImageUrl(
  icon: string | null | undefined,
  image: string | null | undefined,
): { imageUrl?: string } {
  const imageUrl = icon?.trim() || image?.trim();
  return imageUrl ? { imageUrl } : {};
}

function mapBotEvent(event: GammaEvent): PolymarketEvent {
  return {
    id: String(event.id ?? ""),
    createdAt: event.createdAt ?? null,
    slug: event.slug ?? null,
    title: event.title ?? null,
    description: event.description ?? null,
    state: {
      active: event.active === true,
      closed: event.closed === true,
    },
    markets: (event.markets ?? []).map((market) => {
      const labels = parseStringArray(market.outcomes);
      const prices = parseStringArray(market.outcomePrices);
      const yesIndex = labels.findIndex(
        (label) => label.toLowerCase() === "yes",
      );
      const noIndex = labels.findIndex((label) => label.toLowerCase() === "no");
      return {
        slug: market.slug ?? null,
        question: market.question ?? null,
        state: {
          active: market.active === true,
          closed: market.closed === true,
        },
        outcomes: {
          yes: {
            label: labels[yesIndex] ?? "",
            price: parseProbability(prices[yesIndex]),
          },
          no: {
            label: labels[noIndex] ?? "",
            price: parseProbability(prices[noIndex]),
          },
        },
      };
    }),
  };
}

function getAssetOutcomes(
  event: GammaEvent,
): Map<string, { marketSlug: string; outcome: "yes" | "no" }> {
  const assets = new Map<
    string,
    { marketSlug: string; outcome: "yes" | "no" }
  >();
  for (const market of event.markets ?? []) {
    const labels = parseStringArray(market.outcomes);
    const ids = parseStringArray(
      market.version === "v2" ? market.positionIds : market.clobTokenIds,
    );
    const marketSlug = market.slug;
    if (!marketSlug) continue;

    labels.forEach((label, index) => {
      const outcome = label.toLowerCase();
      const assetId = ids[index];
      if (assetId && (outcome === "yes" || outcome === "no")) {
        assets.set(assetId, { marketSlug, outcome });
      }
    });
  }
  return assets;
}

function parseStringArray(
  value: string | string[] | null | undefined,
): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseProbability(value: string | undefined): number | null {
  if (value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null;
  return numeric * 100;
}
