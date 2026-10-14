import {
  parseHyperliquidPerpetualMarketUrl,
  parseHyperliquidPredictionMarketUrl,
} from "./hyperliquid";
import { parsePerplMarketUrl, perplVenue } from "./perpetual-markets/perpl";
import {
  parsePolymarketEventUrl,
  POLYMARKET_VENUE_ID,
} from "./prediction-markets/polymarket/links";
import { type VenueMarketReference } from "./types";

export const supportedMarketLinkVenues = [
  { id: "hyperliquid", parseUrl: parseHyperliquidPredictionMarketUrl },
  { id: "hyperliquid", parseUrl: parseHyperliquidPerpetualMarketUrl },
  { id: POLYMARKET_VENUE_ID, parseUrl: parsePolymarketEventUrl },
  { id: perplVenue.id, parseUrl: parsePerplMarketUrl },
] as const;

export function resolveVenueMarketUrl(
  url: string,
): VenueMarketReference | null {
  for (const venue of supportedMarketLinkVenues) {
    const reference = venue.parseUrl(url);
    if (reference) return reference;
  }

  return null;
}
