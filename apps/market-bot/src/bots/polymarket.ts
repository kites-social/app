import { Effect, Schedule } from "effect";

import {
  isRetryablePolymarketError,
  polymarketVenue,
  type PolymarketEvent,
  type PolymarketPageCursor,
} from "@kites-social/venues";

import {
  type DiscoveredMarket,
  type DiscoveryBatch,
  type MarketBotAdapter,
  type MarketCursor,
} from "../types";

const MAX_POLYMARKET_POSTS_PER_POLL = 10;

export const polymarketBot: MarketBotAdapter = {
  id: "polymarket",
  discover: (cursor) => discover(cursor),
  createPost: (market) => ({
    text: `New on Polymarket: ${market.title}`,
    embed: {
      $type: "social.kites.embed.polymarket",
      url: market.canonicalUrl,
      slug: market.slug,
    },
  }),
};

function discover(
  cursor: MarketCursor | null,
): Effect.Effect<DiscoveryBatch, Error> {
  return Effect.gen(function* () {
    let page = yield* fetchPage();
    const newest = page.items.map(toCursor).find(isCursor) ?? {
      createdAt: new Date().toISOString(),
      itemId: "0",
    };

    if (!cursor) {
      return {
        markets: [],
        cursor: newest,
        initialized: true,
        scannedEvents: page.items.length,
        pagesRead: 1,
      };
    }

    const markets: DiscoveredMarket[] = [];
    let pagesRead = 1;
    let scannedEvents = 0;
    let pageCursor = page.nextCursor;
    const seenPageCursors = new Set<string>();
    let backlogTruncated = false;

    while (true) {
      let reachedCursor = false;
      for (const event of page.items) {
        scannedEvents += 1;
        const itemCursor = toCursor(event);
        if (!itemCursor) continue;
        if (compareCursor(itemCursor, cursor) <= 0) {
          reachedCursor = true;
          break;
        }

        const market = toMarket(event);
        if (market) {
          markets.push(market);
          if (markets.length > MAX_POLYMARKET_POSTS_PER_POLL) {
            markets.pop();
            backlogTruncated = true;
            break;
          }
        }
      }

      if (reachedCursor || backlogTruncated) break;
      if (page.limitReached) {
        throw new Error(
          "Polymarket SDK pagination limit reached before the saved cursor",
        );
      }
      if (!page.hasMore || !pageCursor) break;
      if (seenPageCursors.has(pageCursor)) {
        throw new Error("Polymarket event pagination cursor did not advance");
      }
      seenPageCursors.add(pageCursor);

      page = yield* fetchPage(pageCursor);
      pagesRead += 1;
      pageCursor = page.nextCursor;
    }

    markets.sort((left, right) =>
      compareCursor(
        { createdAt: left.sourceCreatedAt, itemId: left.sourceItemId },
        { createdAt: right.sourceCreatedAt, itemId: right.sourceItemId },
      ),
    );

    if (backlogTruncated) {
      yield* Effect.logWarning(
        `Polymarket backlog exceeded ${MAX_POLYMARKET_POSTS_PER_POLL} eligible events; posting the newest ${MAX_POLYMARKET_POSTS_PER_POLL} and advancing past older events`,
      );
    }

    return {
      markets,
      cursor: compareCursor(newest, cursor) > 0 ? newest : cursor,
      initialized: false,
      scannedEvents,
      pagesRead,
    };
  });
}

function fetchPage(
  cursor?: PolymarketPageCursor,
): Effect.Effect<
  Awaited<ReturnType<typeof polymarketVenue.listEventsPage>>,
  Error
> {
  return Effect.tryPromise({
    try: () => polymarketVenue.listEventsPage(cursor),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.upTo({ times: 3 }),
      ),
      while: isRetryablePolymarketError,
    }),
  );
}

function toMarket(event: PolymarketEvent): DiscoveredMarket | null {
  const cursor = toCursor(event);
  const slug = getString(event.slug);
  const title = getString(event.title);
  if (
    !cursor ||
    !slug ||
    !title ||
    event.state.active !== true ||
    event.state.closed === true
  ) {
    return null;
  }

  const hasActiveBinaryMarket = event.markets.some(
    (market) =>
      market.state.active !== false &&
      market.state.closed !== true &&
      market.outcomes.yes.label.toLowerCase() === "yes" &&
      market.outcomes.no.label.toLowerCase() === "no",
  );
  if (!hasActiveBinaryMarket) return null;

  return {
    sourceItemId: cursor.itemId,
    sourceCreatedAt: cursor.createdAt,
    title,
    slug,
    description: getString(event.description),
    canonicalUrl: `https://polymarket.com/event/${encodeURIComponent(slug)}`,
    active: true,
    closed: false,
  };
}

function toCursor(event: PolymarketEvent): MarketCursor | null {
  const createdAt = event.createdAt;
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, itemId: event.id };
}

function compareCursor(left: MarketCursor, right: MarketCursor): number {
  const dateComparison = left.createdAt.localeCompare(right.createdAt);
  if (dateComparison !== 0) return dateComparison;
  return compareIds(left.itemId, right.itemId);
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }
  return left.localeCompare(right);
}

function getString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCursor(value: MarketCursor | null): value is MarketCursor {
  return value !== null;
}
