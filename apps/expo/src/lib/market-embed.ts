import { type VenueMarketReference } from "./venues/types";

export const VENUE_MARKET_EMBED_TYPE = "social.kites.embed.market" as const;
export const VENUE_MARKET_EMBED_VIEW_TYPE =
  "social.kites.embed.market#view" as const;

// Published records keep their original `$type` on users' PDSes. Continue to
// recognize them when reading, but only emit the new Kites Lexicon IDs.
const LEGACY_VENUE_MARKET_EMBED_TYPE = "app.graysky.embed.market" as const;
const LEGACY_VENUE_MARKET_EMBED_VIEW_TYPE =
  "app.graysky.embed.market#view" as const;

export type VenueMarketEmbedRecord = VenueMarketReference & {
  $type: typeof VENUE_MARKET_EMBED_TYPE;
};

export type VenueMarketEmbedView = VenueMarketReference & {
  $type:
    | typeof VENUE_MARKET_EMBED_VIEW_TYPE
    | typeof VENUE_MARKET_EMBED_TYPE
    | typeof LEGACY_VENUE_MARKET_EMBED_VIEW_TYPE
    | typeof LEGACY_VENUE_MARKET_EMBED_TYPE;
};

export function isVenueMarketEmbedView(
  value: unknown,
): value is VenueMarketEmbedView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    (candidate.$type === VENUE_MARKET_EMBED_TYPE ||
      candidate.$type === VENUE_MARKET_EMBED_VIEW_TYPE ||
      candidate.$type === LEGACY_VENUE_MARKET_EMBED_TYPE ||
      candidate.$type === LEGACY_VENUE_MARKET_EMBED_VIEW_TYPE) &&
    typeof candidate.url === "string" &&
    typeof candidate.venue === "string" &&
    typeof candidate.marketId === "string" &&
    (candidate.marketType === "prediction" ||
      candidate.marketType === "spot" ||
      candidate.marketType === "perpetual") &&
    (candidate.subMarketId === undefined ||
      typeof candidate.subMarketId === "string")
  );
}
