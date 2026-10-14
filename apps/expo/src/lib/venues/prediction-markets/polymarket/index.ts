import { polymarketVenue as basePolymarketVenue } from "@kites-social/venues/src/prediction-markets/polymarket";

import { polymarketOnboarding } from "./onboarding";

export const polymarketVenue = {
  ...basePolymarketVenue,
  onboarding: polymarketOnboarding,
};

export {
  parsePolymarketEventUrl,
  POLYMARKET_VENUE_ID,
  sortPolymarketMarkets,
} from "@kites-social/venues/src/prediction-markets/polymarket";
export {
  fetchPolymarketEvent,
  subscribeToPolymarketEvent,
  usePolymarketEvent,
} from "./use-event";
export {
  checkPolymarketTradingEligibility,
  fetchPolymarketOrderBook,
  POLYMARKET_MINIMUM_SHARES_RAW,
  POLYMARKET_SHARE_DECIMALS,
  usePolymarketTrade,
  usePolymarketOrderBook,
  type OrderBook,
} from "./use-trade";
export { getPolymarketOutcomeBalance } from "./use-trade";
export {
  getPolymarketApiCredentials,
  type PolymarketApiCredentials,
} from "./onboarding";
