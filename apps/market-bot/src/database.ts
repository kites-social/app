import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { TID } from "@atproto/common-web";
import { dirname, resolve } from "node:path";

export interface MarketRecordInput {
  source: string;
  sourceItemId: string;
  sourceCreatedAt: string;
  title: string;
  slug: string;
  description: string | null;
  canonicalUrl: string;
  active: boolean;
  closed: boolean;
}

export interface MarketRecord extends MarketRecordInput {
  id: string;
  recordKey: string;
  postUri: string | null;
  createdAt: Date;
}

export interface BotStateRow {
  cursorCreatedAt: string | null;
  cursorItemId: string | null;
  lastPolledAt: string | null;
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
  recordKey: string | null;
  postUri: string | null;
  createdAt: string;
}

interface StateRow extends Record<string, unknown> {
  cursorCreatedAt: string | null;
  cursorItemId: string | null;
  lastPolledAt: string | null;
}

export interface MarketDatabase {
  externalMarket: {
    upsert: (args: {
      where: { source_sourceItemId: { source: string; sourceItemId: string } };
      create: MarketRecordInput;
      update: Partial<MarketRecordInput>;
    }) => Promise<MarketRecord>;
    update: (args: {
      where: { id: string };
      data: { postUri: string; postCid: string; publishedAt: Date };
    }) => Promise<unknown>;
  };
  marketBotState: {
    findUnique: (args: {
      where: { source: string };
    }) => Promise<BotStateRow | null>;
    upsert: (args: {
      where: { source: string };
      create: {
        source: string;
        cursorCreatedAt: string;
        cursorItemId: string;
        lastPolledAt: string;
        initializedAt: Date;
      };
      update: {
        cursorCreatedAt: string;
        cursorItemId: string;
        lastPolledAt: string;
      };
    }) => Promise<unknown>;
  };
  $disconnect: () => Promise<void>;
}

const configuredPath =
  process.env.MARKET_BOT_DATABASE_PATH ?? "market-bot.sqlite";
const databasePath =
  configuredPath === ":memory:" ? configuredPath : resolve(configuredPath);

if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true });
}

const sqlite = new DatabaseSync(databasePath);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS external_markets (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    source_created_at TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    canonical_url TEXT NOT NULL,
    active INTEGER NOT NULL,
    closed INTEGER NOT NULL,
    record_key TEXT,
    post_uri TEXT UNIQUE,
    post_cid TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source, source_item_id)
  );

  CREATE INDEX IF NOT EXISTS external_markets_source_created_at
    ON external_markets(source, source_created_at);

  CREATE TABLE IF NOT EXISTS market_bot_state (
    source TEXT PRIMARY KEY,
    cursor_created_at TEXT,
    cursor_item_id TEXT,
    last_polled_at TEXT,
    initialized_at TEXT,
    updated_at TEXT NOT NULL
  );
`);

const marketColumns = sqlite
  .prepare("PRAGMA table_info(external_markets)")
  .all() as { name: string }[];
if (!marketColumns.some((column) => column.name === "record_key")) {
  sqlite.exec("ALTER TABLE external_markets ADD COLUMN record_key TEXT");
}
const stateColumns = sqlite
  .prepare("PRAGMA table_info(market_bot_state)")
  .all() as { name: string }[];
if (!stateColumns.some((column) => column.name === "last_polled_at")) {
  sqlite.exec("ALTER TABLE market_bot_state ADD COLUMN last_polled_at TEXT");
}
sqlite.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS external_markets_record_key
  ON external_markets(record_key)
  WHERE record_key IS NOT NULL;
`);

const selectMarket = sqlite.prepare(`
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
`);

export const marketDatabase: MarketDatabase = {
  externalMarket: {
    upsert({ create, update }) {
      return Promise.resolve().then(() => {
        const market = { ...create, ...update };
        const now = new Date().toISOString();
        sqlite
          .prepare(
            `
          INSERT INTO external_markets (
            id, source, source_item_id, source_created_at, title, slug,
            description, canonical_url, active, closed, record_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, source_item_id) DO UPDATE SET
            source_created_at = excluded.source_created_at,
            title = excluded.title,
            slug = excluded.slug,
            description = excluded.description,
            canonical_url = excluded.canonical_url,
            active = excluded.active,
            closed = excluded.closed,
            updated_at = excluded.updated_at
        `,
          )
          .run(
            randomUUID(),
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
          );

        let row = selectMarket.get(market.source, market.sourceItemId) as
          | MarketRow
          | undefined;
        if (!row) {
          throw new Error("SQLite failed to save the discovered market");
        }

        if (!row.recordKey) {
          const recordKey = TID.nextStr();
          sqlite
            .prepare(
              "UPDATE external_markets SET record_key = ? WHERE id = ? AND record_key IS NULL",
            )
            .run(recordKey, row.id);
          row = selectMarket.get(market.source, market.sourceItemId) as
            | MarketRow
            | undefined;
          if (!row?.recordKey) {
            throw new Error("SQLite failed to persist the ATProto record key");
          }
        }

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
      });
    },

    update({ where, data }) {
      return Promise.resolve().then(() => {
        const result = sqlite
          .prepare(
            `
          UPDATE external_markets
          SET post_uri = ?, post_cid = ?, published_at = ?, updated_at = ?
          WHERE id = ?
        `,
          )
          .run(
            data.postUri,
            data.postCid,
            data.publishedAt.toISOString(),
            new Date().toISOString(),
            where.id,
          );
        if (result.changes === 0) {
          throw new Error(`SQLite market record ${where.id} was not found`);
        }
      });
    },
  },

  marketBotState: {
    findUnique({ where }) {
      return Promise.resolve().then(() => {
        const row = sqlite
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
          .get(where.source) as StateRow | undefined;

        return row
          ? {
              cursorCreatedAt: row.cursorCreatedAt,
              cursorItemId: row.cursorItemId,
              lastPolledAt: row.lastPolledAt,
            }
          : null;
      });
    },

    upsert({ create, update }) {
      return Promise.resolve().then(() => {
        const now = new Date().toISOString();
        sqlite
          .prepare(
            `
          INSERT INTO market_bot_state (
            source, cursor_created_at, cursor_item_id, last_polled_at, initialized_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            cursor_created_at = excluded.cursor_created_at,
            cursor_item_id = excluded.cursor_item_id,
            last_polled_at = excluded.last_polled_at,
            updated_at = excluded.updated_at
        `,
          )
          .run(
            create.source,
            update.cursorCreatedAt,
            update.cursorItemId,
            update.lastPolledAt,
            create.initializedAt.toISOString(),
            now,
          );
      });
    },
  },

  $disconnect() {
    sqlite.close();
    return Promise.resolve();
  },
};
