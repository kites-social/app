import { TID } from "@atproto/common-web";

import {
  type BotStateRow,
  type MarketDatabase,
  type MarketRecord,
} from "./database";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1DatabaseBinding {
  prepare(query: string): D1Statement;
}

interface MarketRow extends Record<string, unknown> {
  id: string;
  source: string;
  sourceItemId: string;
  sourceCreatedAt: string;
  title: string;
  slug: string;
  description: string | null;
  canonicalUrl: string;
  active: number;
  closed: number;
  recordKey: string;
  postUri: string | null;
  createdAt: string;
}

interface StateRow extends Record<string, unknown> {
  cursorCreatedAt: string | null;
  cursorItemId: string | null;
  lastPolledAt: string | null;
}

const SELECT_MARKET = `
  SELECT
    id,
    source,
    source_item_id AS sourceItemId,
    source_created_at AS sourceCreatedAt,
    title,
    slug,
    description,
    canonical_url AS canonicalUrl,
    active,
    closed,
    record_key AS recordKey,
    post_uri AS postUri,
    created_at AS createdAt
  FROM external_markets
  WHERE source = ? AND source_item_id = ?
`;

export function createD1MarketDatabase(db: D1DatabaseBinding): MarketDatabase {
  return {
    externalMarket: {
      async upsert({ create, update }) {
        const market = { ...create, ...update };
        const now = new Date().toISOString();

        await db
          .prepare(
            `
              INSERT INTO external_markets (
                id, source, source_item_id, source_created_at, title, slug,
                description, canonical_url, active, closed, record_key,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(source, source_item_id) DO UPDATE SET
                source_created_at = excluded.source_created_at,
                title = excluded.title,
                slug = excluded.slug,
                description = excluded.description,
                canonical_url = excluded.canonical_url,
                active = excluded.active,
                closed = excluded.closed,
                record_key = COALESCE(external_markets.record_key, excluded.record_key),
                updated_at = excluded.updated_at
            `,
          )
          .bind(
            TID.nextStr(),
            market.source,
            market.sourceItemId,
            market.sourceCreatedAt,
            market.title,
            market.slug,
            market.description,
            market.canonicalUrl,
            Number(market.active),
            Number(market.closed),
            TID.nextStr(),
            now,
            now,
          )
          .run();

        const row = await db
          .prepare(SELECT_MARKET)
          .bind(market.source, market.sourceItemId)
          .first<MarketRow>();

        if (!row) {
          throw new Error("D1 failed to save the discovered market");
        }

        return toMarketRecord(row);
      },

      async update({ where, data }) {
        const result = await db
          .prepare(
            `
              UPDATE external_markets
              SET post_uri = ?, post_cid = ?, published_at = ?, updated_at = ?
              WHERE id = ?
            `,
          )
          .bind(
            data.postUri,
            data.postCid,
            data.publishedAt.toISOString(),
            new Date().toISOString(),
            where.id,
          )
          .run();

        if (result.meta.changes === 0) {
          throw new Error(`D1 market record ${where.id} was not found`);
        }
      },
    },

    marketBotState: {
      async findUnique({ where }): Promise<BotStateRow | null> {
        const row = await db
          .prepare(
            `
              SELECT
                cursor_created_at AS cursorCreatedAt,
                cursor_item_id AS cursorItemId,
                last_polled_at AS lastPolledAt
              FROM market_bot_state
              WHERE source = ?
            `,
          )
          .bind(where.source)
          .first<StateRow>();

        return row
          ? {
              cursorCreatedAt: row.cursorCreatedAt,
              cursorItemId: row.cursorItemId,
              lastPolledAt: row.lastPolledAt,
            }
          : null;
      },

      async upsert({ create, update }) {
        const now = new Date().toISOString();
        await db
          .prepare(
            `
              INSERT INTO market_bot_state (
                source, cursor_created_at, cursor_item_id,
                last_polled_at, initialized_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(source) DO UPDATE SET
                cursor_created_at = excluded.cursor_created_at,
                cursor_item_id = excluded.cursor_item_id,
                last_polled_at = excluded.last_polled_at,
                updated_at = excluded.updated_at
            `,
          )
          .bind(
            create.source,
            update.cursorCreatedAt,
            update.cursorItemId,
            update.lastPolledAt,
            create.initializedAt.toISOString(),
            now,
          )
          .run();
      },
    },

    $disconnect: async () => undefined,
  };
}

function toMarketRecord(row: MarketRow): MarketRecord {
  return {
    id: row.id,
    recordKey: row.recordKey,
    source: row.source,
    sourceItemId: row.sourceItemId,
    sourceCreatedAt: row.sourceCreatedAt,
    title: row.title,
    slug: row.slug,
    description: row.description,
    canonicalUrl: row.canonicalUrl,
    active: Boolean(row.active),
    closed: Boolean(row.closed),
    postUri: row.postUri,
    createdAt: new Date(row.createdAt),
  };
}
