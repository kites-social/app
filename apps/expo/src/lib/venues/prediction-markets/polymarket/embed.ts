import { parsePolymarketEventUrl as parseEventUrl } from "@kites-social/venues/src/prediction-markets/polymarket/links";

export const POLYMARKET_EMBED_TYPE = "social.kites.embed.polymarket" as const;
export const POLYMARKET_EMBED_VIEW_TYPE =
  "social.kites.embed.polymarket#view" as const;

const LEGACY_POLYMARKET_EMBED_TYPE = "app.graysky.embed.polymarket" as const;
const LEGACY_POLYMARKET_EMBED_VIEW_TYPE =
  "app.graysky.embed.polymarket#view" as const;

export interface PolymarketEmbedRecord {
  $type: typeof POLYMARKET_EMBED_TYPE;
  url: string;
  slug: string;
  marketSlug?: string;
}

export interface PolymarketEmbedView {
  $type:
    | typeof POLYMARKET_EMBED_VIEW_TYPE
    | typeof POLYMARKET_EMBED_TYPE
    | typeof LEGACY_POLYMARKET_EMBED_VIEW_TYPE
    | typeof LEGACY_POLYMARKET_EMBED_TYPE;
  url: string;
  slug: string;
  marketSlug?: string;
}

export function parsePolymarketEventUrl(
  value: string,
): { url: string; slug: string; marketSlug?: string } | null {
  const reference = parseEventUrl(value);
  if (!reference) return null;

  return {
    url: reference.url,
    slug: reference.marketId,
    ...(reference.subMarketId ? { marketSlug: reference.subMarketId } : {}),
  };
}

export function isPolymarketEmbedView(
  value: unknown,
): value is PolymarketEmbedView {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.$type === POLYMARKET_EMBED_TYPE ||
      candidate.$type === POLYMARKET_EMBED_VIEW_TYPE ||
      candidate.$type === LEGACY_POLYMARKET_EMBED_TYPE ||
      candidate.$type === LEGACY_POLYMARKET_EMBED_VIEW_TYPE) &&
    typeof candidate.url === "string" &&
    typeof candidate.slug === "string" &&
    (candidate.marketSlug === undefined ||
      typeof candidate.marketSlug === "string")
  );
}
