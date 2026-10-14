import { Effect } from "effect";

import type { WorkerEnv } from "../alchemy.run";
import { createD1MarketDatabase } from "./d1-database";
import { runPollOnce } from "./runner";

interface MarketBotScheduledController {
  cron: string;
  scheduledTime: number;
}

export default {
  fetch() {
    return new Response("Kites market bots are scheduled.");
  },

  async scheduled(controller: MarketBotScheduledController, env: WorkerEnv) {
    console.info(
      `Market bot cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`,
    );

    await Effect.runPromise(
      runPollOnce(createD1MarketDatabase(env.MARKET_BOT_DB), {
        pollIntervalSeconds: positiveInteger(
          env.MARKET_BOT_POLL_INTERVAL_SECONDS,
          60,
        ),
        dryRun: env.MARKET_BOT_DRY_RUN !== "false",
        handle: env.MARKET_BOT_HANDLE,
        appPassword: env.MARKET_BOT_APP_PASSWORD,
        serviceUrl: env.ATPROTO_SERVICE_URL,
      }),
    );
  },
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
