import { type PredictionMarketReference } from "../../types";

export const POLYMARKET_VENUE_ID = "polymarket";

export function parsePolymarketEventUrl(
  value: string,
): PredictionMarketReference | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "polymarket.com" ||
      parsed.port !== ""
    ) {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] !== "event" || !segments[1]) return null;

    const marketId = decodeURIComponent(segments[1]);
    const subMarketId = segments[2]
      ? decodeURIComponent(segments[2])
      : undefined;
    if (!marketId) return null;

    return {
      marketType: "prediction",
      venue: POLYMARKET_VENUE_ID,
      url: parsed.toString(),
      marketId,
      ...(subMarketId ? { subMarketId } : {}),
    };
  } catch {
    return null;
  }
}
