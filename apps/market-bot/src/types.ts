import { type Effect } from "effect";

export interface MarketCursor {
  createdAt: string;
  itemId: string;
}

export interface DiscoveredMarket {
  sourceItemId: string;
  sourceCreatedAt: string;
  title: string;
  slug: string;
  description: string | null;
  canonicalUrl: string;
  active: boolean;
  closed: boolean;
  marketEmbed?: {
    marketType: "prediction" | "perpetual";
    venue: string;
    marketId: string;
    subMarketId?: string;
  };
  volume24hUsd?: number;
}

export interface DiscoveryBatch {
  markets: DiscoveredMarket[];
  cursor: MarketCursor;
  initialized: boolean;
  scannedEvents: number;
  pagesRead: number;
}

export interface MarketBotAdapter {
  readonly id: string;
  readonly pollIntervalSeconds?: number;
  discover: (
    cursor: MarketCursor | null,
  ) => Effect.Effect<DiscoveryBatch, Error>;
  createPost: (market: DiscoveredMarket) => {
    text: string;
    embed: Record<string, unknown>;
  };
}
