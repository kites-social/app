import {
  hyperliquidPerpetualVenue,
  hyperliquidPredictionVenue,
} from "./hyperliquid";
import { perplMarketVenue } from "./perpetual-markets/perpl";
import { polymarketVenue } from "./prediction-markets/polymarket";
import {
  type PerpetualMarketVenue,
  type PredictionMarketVenue,
  type SpotMarketVenue,
} from "./types";

export interface SpotAssetDefinition {
  symbol: string;
  name: string;
}

export const spotAssetRegistry: Record<string, SpotAssetDefinition> = {};
export const spotMarketVenues: SpotMarketVenue[] = [];
export const predictionMarketVenues: PredictionMarketVenue[] = [
  polymarketVenue,
  hyperliquidPredictionVenue,
];
export const perpetualMarketVenues: PerpetualMarketVenue[] = [
  perplMarketVenue,
  hyperliquidPerpetualVenue,
];

const marketVenues = [
  ...spotMarketVenues,
  ...predictionMarketVenues,
  ...perpetualMarketVenues,
];

const onboardingByVenue = new Map<
  string,
  {
    venue: (typeof marketVenues)[number] & {
      supportedMarketTypes: (typeof marketVenues)[number]["marketType"][];
    };
    onboarding: NonNullable<(typeof marketVenues)[number]["onboarding"]>;
  }
>();

for (const venue of marketVenues) {
  if (!venue.onboarding) continue;
  const existing = onboardingByVenue.get(venue.id);
  if (existing) {
    if (!existing.venue.supportedMarketTypes.includes(venue.marketType)) {
      existing.venue.supportedMarketTypes.push(venue.marketType);
    }
    continue;
  }
  onboardingByVenue.set(venue.id, {
    venue: {
      ...venue,
      supportedMarketTypes: venue.supportedMarketTypes ?? [venue.marketType],
    },
    onboarding: venue.onboarding,
  });
}

export const onboardingVenues = [...onboardingByVenue.values()];
