import { perplVenue as basePerplVenue } from "@kites-social/venues/src/perpetual-markets/perpl";

import { perplMarketVenue as basePerplMarketVenue } from "./market-data";
import { perplOnboarding } from "./onboarding";

export const perplVenue = {
  ...basePerplVenue,
  onboarding: perplOnboarding,
};

export const perplMarketVenue = {
  ...basePerplMarketVenue,
  onboarding: perplOnboarding,
};

export {
  getPerplNetwork,
  parsePerplMarketUrl,
} from "@kites-social/venues/src/perpetual-markets/perpl";
export { usePerplMarket } from "./use-market";
