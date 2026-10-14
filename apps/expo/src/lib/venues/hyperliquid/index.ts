import {
  hyperliquidVenue as baseHyperliquidVenue,
  type PerpetualMarketVenue,
  type PredictionMarketVenue,
} from "@kites-social/venues";

import { hyperliquidPerpetualMarketVenue } from "./market-data";
import { hyperliquidOnboarding } from "./onboarding";
import { hyperliquidPredictionMarketVenue } from "./prediction-data";

export const hyperliquidPerpetualVenue: PerpetualMarketVenue = {
  ...baseHyperliquidVenue,
  ...hyperliquidPerpetualMarketVenue,
  marketType: "perpetual",
  onboarding: hyperliquidOnboarding,
};

export const hyperliquidPredictionVenue: PredictionMarketVenue = {
  ...baseHyperliquidVenue,
  ...hyperliquidPredictionMarketVenue,
  marketType: "prediction",
  onboarding: hyperliquidOnboarding,
};

export {
  parseHyperliquidPerpetualMarketUrl,
  parseHyperliquidPredictionMarketUrl,
  HYPERLIQUID_TESTNET_APP_URL,
  HYPERLIQUID_VENUE_ID,
} from "@kites-social/venues";
export {
  useHyperliquidMarket,
  useHyperliquidMarketSymbols,
  useHyperliquidPriceHistory,
} from "./use-market";
export { useHyperliquidEvent } from "./use-event";
