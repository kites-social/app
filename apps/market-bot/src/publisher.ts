import { BskyAgent } from "@atproto/api";
import { Effect } from "effect";

import { type MarketDatabase } from "./database";
import {
  createRateLimitedFetch,
  normalizeAtprotoError,
  reserveRepoWrite,
  reserveSessionAttempt,
} from "./rate-limit";
import { type DiscoveredMarket, type MarketBotAdapter } from "./types";

export interface PublisherConfig {
  service: string;
  handle: string;
  appPassword: string;
}

export interface PublisherSession {
  agent: BskyAgent;
  did: string;
  service: string;
}

interface CachedPublisher {
  appPassword: string;
  promise: Promise<PublisherSession>;
}

const publisherSessions = new Map<string, CachedPublisher>();

export function login(
  config: PublisherConfig,
): Effect.Effect<PublisherSession, Error> {
  return Effect.tryPromise({
    try: () => getOrCreatePublisher(config),
    catch: (cause) => normalizeAtprotoError(cause, config.service),
  });
}

function getOrCreatePublisher(
  config: PublisherConfig,
): Promise<PublisherSession> {
  const key = `${config.service}\u0000${config.handle.toLowerCase()}`;
  const cached = publisherSessions.get(key);
  if (cached?.appPassword === config.appPassword) return cached.promise;

  const promise = (async () => {
    reserveSessionAttempt(config.service, config.handle);
    const agent = new BskyAgent({
      service: config.service,
      fetch: createRateLimitedFetch(config.service),
    });
    const session = await agent.login({
      identifier: config.handle,
      password: config.appPassword,
    });
    return { agent, did: session.data.did, service: config.service };
  })();

  publisherSessions.set(key, { appPassword: config.appPassword, promise });
  void promise.catch(() => {
    if (publisherSessions.get(key)?.promise === promise) {
      publisherSessions.delete(key);
    }
  });
  return promise;
}

export function persistAndPublish(
  database: MarketDatabase,
  publisher: PublisherSession,
  adapter: MarketBotAdapter,
  market: DiscoveredMarket,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const saved = yield* Effect.tryPromise({
      try: () =>
        database.externalMarket.upsert({
          where: {
            source_sourceItemId: {
              source: adapter.id,
              sourceItemId: market.sourceItemId,
            },
          },
          create: {
            source: adapter.id,
            sourceItemId: market.sourceItemId,
            sourceCreatedAt: market.sourceCreatedAt,
            title: market.title,
            slug: market.slug,
            description: market.description,
            canonicalUrl: market.canonicalUrl,
            active: market.active,
            closed: market.closed,
          },
          update: {
            sourceCreatedAt: market.sourceCreatedAt,
            title: market.title,
            slug: market.slug,
            description: market.description,
            canonicalUrl: market.canonicalUrl,
            active: market.active,
            closed: market.closed,
          },
        }),
      catch: toError,
    });

    if (saved.postUri) return;

    const post = adapter.createPost(market);
    const response = yield* Effect.tryPromise({
      try: () => {
        reserveRepoWrite(publisher.service, publisher.did);
        return publisher.agent.com.atproto.repo.putRecord({
          repo: publisher.did,
          collection: "app.bsky.feed.post",
          rkey: saved.recordKey,
          record: {
            $type: "app.bsky.feed.post",
            text: post.text,
            embed: post.embed,
            createdAt: saved.createdAt.toISOString(),
          },
        });
      },
      catch: (cause) => normalizeAtprotoError(cause, publisher.service),
    });

    yield* Effect.tryPromise({
      try: () =>
        database.externalMarket.update({
          where: { id: saved.id },
          data: {
            postUri: response.data.uri,
            postCid: response.data.cid,
            publishedAt: new Date(),
          },
        }),
      catch: toError,
    });

    yield* Effect.logInfo(
      `Published ${adapter.id} market ${market.sourceItemId}`,
    );
  });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
