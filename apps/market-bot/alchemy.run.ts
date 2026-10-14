import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const database = Cloudflare.D1.Database("MarketBotDatabase", {
  migrations: "./migrations",
});

const worker = Cloudflare.Worker("MarketBotWorker", {
  main: "./src/cloudflare.ts",
  crons: ["* * * * *"],
  compatibility: {
    date: "2026-08-31",
    flags: ["nodejs_compat"],
  },
  env: {
    MARKET_BOT_DB: database,
    MARKET_BOT_HANDLE: Config.String("MARKET_BOT_HANDLE").pipe(
      Config.withDefault(""),
    ),
    MARKET_BOT_APP_PASSWORD: Config.String("MARKET_BOT_APP_PASSWORD").pipe(
      Config.withDefault(""),
    ),
    MARKET_BOT_DRY_RUN: Config.String("MARKET_BOT_DRY_RUN").pipe(
      Config.withDefault("true"),
    ),
    MARKET_BOT_POLL_INTERVAL_SECONDS: Config.String(
      "MARKET_BOT_POLL_INTERVAL_SECONDS",
    ).pipe(Config.withDefault("60")),
    ATPROTO_SERVICE_URL: Config.String("ATPROTO_SERVICE_URL").pipe(
      Config.withDefault("https://bsky.social"),
    ),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof worker>;

export default Alchemy.Stack(
  "KitesMarketBots",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const deployedDatabase = yield* database;
    const deployedWorker = yield* worker;

    return {
      url: deployedWorker.url.as<string>(),
      cron: deployedWorker.crons,
      databaseName: deployedDatabase.databaseName,
    };
  }),
);
