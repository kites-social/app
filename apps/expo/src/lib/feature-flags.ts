/**
 * Public, build-time feature flags for the Expo app.
 *
 * These values are intentionally strict: a flag is enabled only when its
 * environment variable is explicitly set to "true".
 */
export const featureFlags = {
  postToMarket: process.env.EXPO_PUBLIC_POST_TO_MARKET_ENABLED === "true",
};
