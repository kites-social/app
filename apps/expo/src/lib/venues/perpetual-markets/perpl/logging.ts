import * as Sentry from "@sentry/react-native";
import { type Address } from "viem";

type PerplSetupLogData = Record<string, unknown>;
type PerplLogData = Record<string, unknown>;

export function logPerplSetup(event: string, data: PerplSetupLogData = {}) {
  console.info(`[Perpl setup] ${event}`, data);
  Sentry.addBreadcrumb({
    category: "perpl.setup",
    message: event,
    level: "info",
    data,
  });
}

export function logPerplPositions(event: string, data: PerplLogData = {}) {
  console.info(`[Perpl positions] ${event}`, data);
  Sentry.addBreadcrumb({
    category: "perpl.positions",
    message: event,
    level: "info",
    data,
  });
}

export function logPerplTrade(event: string, data: PerplLogData = {}) {
  console.info(`[Perpl trade] ${event}`, data);
  Sentry.addBreadcrumb({
    category: "perpl.trade",
    message: event,
    level: "info",
    data,
  });
}

export function capturePerplSetupError(error: unknown, walletAddress: Address) {
  console.error("[Perpl setup] failed", { walletAddress, error });
  Sentry.captureException(error, {
    tags: { area: "venue_setup", venue: "perpl" },
    extra: { walletAddress },
  });
}
