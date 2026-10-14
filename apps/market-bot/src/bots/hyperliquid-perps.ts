import { Effect } from "effect";

import { fetchRandomHyperliquidPerpetualMarket } from "@kites-social/venues";

import {
  type DiscoveredMarket,
  type DiscoveryBatch,
  type MarketBotAdapter,
  type MarketCursor,
} from "../types";

const POST_INTERVAL_SECONDS = 35 * 60;
const POST_INTERVAL_MS = POST_INTERVAL_SECONDS * 1_000;

export const hyperliquidPerpsBot: MarketBotAdapter = {
  id: "hyperliquid-perps",
  pollIntervalSeconds: POST_INTERVAL_SECONDS,
  discover: (cursor) => discover(cursor),
  createPost: (market) => ({
    text: `Random Hyperliquid perp: ${market.title}.`,
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
      const now = new Date();
      if (
        cursor &&
        now.getTime() - Date.parse(cursor.createdAt) < POST_INTERVAL_MS
      ) {
        return {
          markets: [],
          cursor,
          initialized: false,
          scannedEvents: 0,
          pagesRead: 0,
        };
      }

      const selectedMarket = await fetchRandomHyperliquidPerpetualMarket();
      if (!selectedMarket) {
        return {
          markets: [],
          cursor: {
            createdAt: now.toISOString(),
            itemId: cursor?.itemId ?? "none",
          },
          initialized: false,
          scannedEvents: 0,
          pagesRead: 1,
        };
      }

      const slot = Math.floor(now.getTime() / POST_INTERVAL_MS);
      const market: DiscoveredMarket = {
        sourceItemId: String(slot),
        sourceCreatedAt: now.toISOString(),
        title: selectedMarket.symbol,
        slug: selectedMarket.symbol,
        description: null,
        canonicalUrl: selectedMarket.canonicalUrl,
        active: true,
        closed: false,
        marketEmbed: {
          marketType: "perpetual",
          venue: "hyperliquid",
          marketId: selectedMarket.symbol,
        },
      };

      return {
        markets: [market],
        cursor: { createdAt: now.toISOString(), itemId: String(slot) },
        initialized: false,
        scannedEvents: 1,
        pagesRead: 1,
      };
    },
    catch: toError,
  });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
