import { type VenueOnboardingProvider } from "@kites-social/venues";

export const hyperliquidOnboarding: VenueOnboardingProvider = {
  getSteps: () =>
    Promise.resolve([
      {
        id: "coming-soon",
        title: "Unavailable",
        description: "Hyperliquid trading is coming soon.",
        kind: "information",
        status: "blocked",
      },
    ]),
  runStep: (stepId) =>
    Promise.reject(
      new Error(`Hyperliquid has no manual setup action: ${stepId}`),
    ),
};
