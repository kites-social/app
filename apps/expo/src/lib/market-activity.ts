import { AtpAgent, type AppBskyActorDefs } from "@atproto/api";

import { resolvePdsFromDid } from "~/lib/utils/resolve-pds";

export const MARKET_ACTIVITY_COLLECTION = "social.kites.feed.marketActivity";

export type MarketActivityMarketType = "prediction" | "spot" | "perpetual";
export type MarketActivitySide = "buy" | "sell" | "long" | "short";

export interface MarketActivity {
  uri: string;
  cid: string;
  actor: AppBskyActorDefs.ProfileViewBasic;
  subject: { uri: string; cid: string };
  market: {
    venue: string;
    marketType: MarketActivityMarketType;
    marketId: string;
    label?: string;
  };
  side: MarketActivitySide;
  outcome?: "yes" | "no";
  createdAt: string;
}

export interface PublishMarketActivityInput {
  subject: { uri: string; cid: string };
  market: MarketActivity["market"];
  side: MarketActivitySide;
  outcome?: "yes" | "no";
}

export async function publishMarketActivity(
  agent: AtpAgent,
  input: PublishMarketActivityInput,
) {
  const did = agent.session?.did;
  if (!did || !isAtUri(input.subject.uri) || !input.subject.cid) return;

  const record = {
    $type: MARKET_ACTIVITY_COLLECTION,
    version: 1,
    subject: input.subject,
    market: {
      ...input.market,
      marketId: input.market.marketId.slice(0, 256),
      ...(input.market.label
        ? { label: input.market.label.slice(0, 256) }
        : {}),
    },
    side: input.side,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    createdAt: new Date().toISOString(),
  };
  await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: MARKET_ACTIVITY_COLLECTION,
    record: record as never,
  });
}

export async function getMarketActivitiesForFollow(
  actor: AppBskyActorDefs.ProfileViewBasic,
  pdsUrl: string,
  since: number,
): Promise<MarketActivity[]> {
  const pds = new AtpAgent({ service: pdsUrl });
  const response = await pds.com.atproto.repo.listRecords({
    repo: actor.did,
    collection: MARKET_ACTIVITY_COLLECTION,
    limit: 100,
    reverse: true,
  });
  return response.data.records.flatMap((record) => {
    const parsed = parseMarketActivity(record.value);
    if (!parsed || Date.parse(parsed.createdAt) < since) return [];
    return [{ ...parsed, uri: record.uri, cid: record.cid, actor }];
  });
}

export async function resolveMarketActivities(
  follows: AppBskyActorDefs.ProfileViewBasic[],
  since: number,
): Promise<MarketActivity[]> {
  const results: MarketActivity[] = [];
  let next = 0;
  const workerCount = Math.min(8, follows.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < follows.length) {
      const follow = follows[next++];
      if (!follow) continue;
      try {
        const pdsUrl = await resolvePdsFromDid(follow.did);
        const records = await getMarketActivitiesForFollow(
          follow,
          pdsUrl,
          since,
        );
        results.push(...records);
      } catch {
        // An unavailable PDS must not prevent other followed users' actions
        // from appearing in the timeline.
      }
    }
  });
  await Promise.all(workers);
  return results.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

export function isAtUri(value: string): boolean {
  return /^at:\/\/did:[a-z0-9:.-]+\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._~:-]+$/.test(
    value,
  );
}

function parseMarketActivity(value: unknown): Omit<
  MarketActivity,
  "uri" | "cid" | "actor"
> | null {
  if (!isRecord(value) || value.$type !== MARKET_ACTIVITY_COLLECTION) {
    return null;
  }
  if (value.version !== 1 || !isRecord(value.subject) || !isRecord(value.market)) {
    return null;
  }
  if (
    typeof value.subject.uri !== "string" ||
    typeof value.subject.cid !== "string" ||
    !isAtUri(value.subject.uri) ||
    typeof value.market.venue !== "string" ||
    !isMarketType(value.market.marketType) ||
    typeof value.market.marketId !== "string" ||
    !isSide(value.side) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return null;
  }
  return {
    subject: { uri: value.subject.uri, cid: value.subject.cid },
    market: {
      venue: value.market.venue,
      marketType: value.market.marketType,
      marketId: value.market.marketId,
      ...(typeof value.market.label === "string"
        ? { label: value.market.label }
        : {}),
    },
    side: value.side,
    ...(value.outcome === "yes" || value.outcome === "no"
      ? { outcome: value.outcome }
      : {}),
    createdAt: value.createdAt,
  };
}

function isMarketType(value: unknown): value is MarketActivityMarketType {
  return value === "prediction" || value === "spot" || value === "perpetual";
}

function isSide(value: unknown): value is MarketActivitySide {
  return value === "buy" || value === "sell" || value === "long" || value === "short";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
