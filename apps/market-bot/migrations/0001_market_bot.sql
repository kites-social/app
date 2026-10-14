CREATE TABLE external_markets (
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
  record_key TEXT NOT NULL UNIQUE,
  post_uri TEXT UNIQUE,
  post_cid TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_item_id)
);

CREATE INDEX external_markets_source_created_at
  ON external_markets(source, source_created_at);

CREATE TABLE market_bot_state (
  source TEXT PRIMARY KEY,
  cursor_created_at TEXT,
  cursor_item_id TEXT,
  last_polled_at TEXT,
  initialized_at TEXT,
  updated_at TEXT NOT NULL
);
