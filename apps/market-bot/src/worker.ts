import { Effect, Schedule } from "effect";

import { marketDatabase } from "./database";
import { runPollOnce } from "./runner";

const pollIntervalSeconds = positiveInteger(
  process.env.MARKET_BOT_POLL_INTERVAL_SECONDS,
  60,
);
const dryRun = process.env.MARKET_BOT_DRY_RUN !== "false";

export const run = Effect.gen(function* () {
  yield* Effect.logInfo(
    `Starting market bot${dryRun ? " in dry-run mode" : ""}`,
  );

  yield* Effect.repeat(
    runPollOnce(marketDatabase, {
      pollIntervalSeconds,
      dryRun,
      handle: process.env.MARKET_BOT_HANDLE,
      appPassword: process.env.MARKET_BOT_APP_PASSWORD,
      serviceUrl: process.env.ATPROTO_SERVICE_URL ?? "https://bsky.social",
    }),
    Schedule.spaced(`${Math.min(pollIntervalSeconds, 60)} seconds`),
  );
});

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
