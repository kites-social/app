import * as Sentry from "@sentry/react-native";

/**
 * Logs a flow event with a stable `[scope] event` prefix so the onboarding
 * sequence can be reconstructed from `adb logcat | grep "\[flow:"`.
 */
export function logFlow(
  scope: "auth" | "nav" | "wallet" | "polymarket",
  event: string,
  data: Record<string, unknown> = {},
) {
  console.info(`[flow:${scope}] ${event}`, data);
  Sentry.addBreadcrumb({
    category: `flow.${scope}`,
    message: event,
    level: "info",
    data,
  });
}

/** Short, single-line call-site hint so we can see who triggered an action. */
export function callerHint() {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(2, 6)
    .map((line) => line.trim())
    .join(" <- ");
}
