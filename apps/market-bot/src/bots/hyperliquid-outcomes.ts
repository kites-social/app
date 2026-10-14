import { Effect } from "effect";

import {
  HYPERLIQUID_OUTCOME_CURSOR_CREATED_AT,
  listHyperliquidOutcomeMarkets,
} from "@kites-social/venues";

import {
  type DiscoveredMarket,
  type DiscoveryBatch,
  type MarketBotAdapter,
  type MarketCursor,
} from "../types";

export const hyperliquidOutcomesBot: MarketBotAdapter = {
  id: "hyperliquid-outcomes",
  discover: (cursor) => discover(cursor),
  createPost: (market) => ({
    text: `New on Hyperliquid: ${market.title}`,
    embed: {
      $type: "social.kites.embed.market",
      url: market.canonicalUrl,
      ...market.marketEmbed,
    },
  }),
};

function discover(
  cursor: MarketCursor | null,
): Effect.Effect<DiscoveryBatch, Error> {
  return Effect.tryPromise({
    try: async () => {
      const events = await listHyperliquidOutcomeMarkets();
      const newest = events.at(-1);
      const nextCursor = newest
        ? {
            createdAt: HYPERLIQUID_OUTCOME_CURSOR_CREATED_AT,
            itemId: String(newest.id),
          }
        : {
            createdAt: HYPERLIQUID_OUTCOME_CURSOR_CREATED_AT,
            itemId: "0",
          };

      if (!cursor) {
        return {
          markets: [],
          cursor: nextCursor,
          initialized: true,
          scannedEvents: events.length,
          pagesRead: 1,
        };
      }

      const markets = events.flatMap((event) => {
        if (
          event.resolved ||
          compareIds(String(event.id), cursor.itemId) <= 0
        ) {
          return [];
        }
        const market: DiscoveredMarket = {
          sourceItemId: String(event.id),
          sourceCreatedAt: new Date().toISOString(),
          title: event.title,
          slug: event.outcomeSlug,
          description: null,
          canonicalUrl: event.canonicalUrl,
          active: true,
          closed: false,
          marketEmbed: {
            marketType: "prediction",
            venue: "hyperliquid",
            marketId: event.questionId ?? `outcome:${event.outcomeSlug}`,
            ...(event.questionId ? { subMarketId: String(event.id) } : {}),
          },
        };
        return [market];
      });

      return {
        markets,
        cursor: nextCursor,
        initialized: false,
        scannedEvents: events.length,
        pagesRead: 1,
      };
    },
    catch: toError,
  });
}

function compareIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }
  return left.localeCompare(right);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
