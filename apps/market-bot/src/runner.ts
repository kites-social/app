import { Effect, Schedule } from "effect";

import { marketBots } from "./bots";
import { type MarketDatabase } from "./database";
import { login, persistAndPublish, type PublisherSession } from "./publisher";
import {
  isMarketBotRateLimitError,
  publisherCooldownMs,
} from "./rate-limit";
import { type MarketBotAdapter, type MarketCursor } from "./types";

export interface MarketBotConfig {
  pollIntervalSeconds: number;
  dryRun: boolean;
  handle?: string;
  appPassword?: string;
  serviceUrl?: string;
}

export function runPollOnce(
  database: MarketDatabase,
  config: MarketBotConfig,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const serviceUrl = config.serviceUrl ?? "https://bsky.social";
    const cooldownMs = publisherCooldownMs(serviceUrl);
    if (cooldownMs > 0) {
      yield* Effect.logWarning(
        `Bluesky rate limit cooldown active for ${Math.ceil(cooldownMs / 1_000)}s; skipping this poll`,
      );
      return;
    }

    const handle = config.handle?.trim();
    const appPassword = config.appPassword;
    if (!config.dryRun && (!handle || !appPassword)) {
      return yield* Effect.fail(
        new Error("Set MARKET_BOT_HANDLE and MARKET_BOT_APP_PASSWORD"),
      );
    }

    let publisher: PublisherSession | undefined;
    const getPublisher = (): Effect.Effect<PublisherSession, Error> =>
      publisher
        ? Effect.succeed(publisher)
        : login({
            service: serviceUrl,
            handle: handle!,
            appPassword: appPassword!,
          }).pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                publisher = session;
              }),
            ),
          );

    for (const bot of marketBots) {
      if (publisherCooldownMs(serviceUrl) > 0) break;
      const stateResult = yield* Effect.tryPromise({
        try: () =>
          database.marketBotState.findUnique({ where: { source: bot.id } }),
        catch: toError,
      }).pipe(
        Effect.map((state) => ({ state, failed: false as const })),
        Effect.catch((error) =>
          Effect.logError(
            `${bot.id} schedule state read failed: ${error.message}`,
          ).pipe(Effect.as({ state: null, failed: true as const })),
        ),
      );
      if (stateResult.failed) continue;

      const state = stateResult.state;
      const lastPolledAt = state?.lastPolledAt
        ? Date.parse(state.lastPolledAt)
        : NaN;
      const intervalMs =
        (bot.pollIntervalSeconds ?? config.pollIntervalSeconds) * 1_000;
      if (
        Number.isFinite(lastPolledAt) &&
        Date.now() - lastPolledAt < intervalMs
      ) {
        continue;
      }

      yield* syncBot(database, bot, state, getPublisher, config.dryRun).pipe(
        Effect.retry({
          schedule: Schedule.exponential("1 second").pipe(
            Schedule.upTo({ times: 3 }),
          ),
          while: (error) => !isMarketBotRateLimitError(error),
        }),
        Effect.tap(() =>
          Effect.logInfo(`${bot.id} poll completed successfully`),
        ),
        Effect.catch((error) =>
          isMarketBotRateLimitError(error)
            ? Effect.logWarning(`${bot.id} paused: ${error.message}`)
            : Effect.logError(`${bot.id} sync failed: ${error.message}`),
        ),
      );
    }
  });
}

function syncBot(
  database: MarketDatabase,
  bot: MarketBotAdapter,
  state: Awaited<ReturnType<MarketDatabase["marketBotState"]["findUnique"]>>,
  getPublisher: () => Effect.Effect<PublisherSession, Error>,
  dryRun: boolean,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const cursor =
      state?.cursorCreatedAt && state.cursorItemId
        ? { createdAt: state.cursorCreatedAt, itemId: state.cursorItemId }
        : null;
    const batch = yield* bot.discover(cursor);
    yield* Effect.logInfo(
      `${bot.id}: scanned ${batch.scannedEvents} events across ${batch.pagesRead} page(s); ${batch.markets.length} eligible new event(s)`,
    );

    if (dryRun) {
      yield* saveCursor(database, bot.id, batch.cursor);
      if (batch.initialized) {
        yield* Effect.logInfo(
          `${bot.id}: baseline saved; no historical posts created`,
        );
      }
      for (const market of batch.markets) {
        yield* Effect.logInfo(`${bot.id}: would post ${market.title}`);
      }
      return;
    }

    for (const market of batch.markets) {
      const session = yield* getPublisher();
      yield* persistAndPublish(database, session, bot, market);
    }

    yield* saveCursor(database, bot.id, batch.cursor);

    if (batch.initialized) {
      yield* Effect.logInfo(
        `${bot.id}: baseline initialized; no old posts created`,
      );
    } else if (batch.markets.length > 0) {
      yield* Effect.logInfo(
        `${bot.id}: processed ${batch.markets.length} new events`,
      );
    }
  });
}

function saveCursor(
  database: MarketDatabase,
  source: string,
  cursor: MarketCursor,
): Effect.Effect<void, Error> {
  const now = new Date();
  const lastPolledAt = now.toISOString();
  return Effect.tryPromise<void, Error>({
    try: () =>
      database.marketBotState
        .upsert({
          where: { source },
          create: {
            source,
            cursorCreatedAt: cursor.createdAt,
            cursorItemId: cursor.itemId,
            lastPolledAt,
            initializedAt: now,
          },
          update: {
            cursorCreatedAt: cursor.createdAt,
            cursorItemId: cursor.itemId,
            lastPolledAt,
          },
        })
        .then(() => undefined),
    catch: toError,
  });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
