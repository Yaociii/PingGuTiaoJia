/**
 * SQLite schema definition for Gacha Pricer.
 * Single source of truth: the 8 Record interfaces in server/types.ts + meta table.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code            TEXT PRIMARY KEY,
  owner_note      TEXT    NOT NULL DEFAULT '',
  daily_limit     INTEGER NOT NULL DEFAULT 50,
  used_today      INTEGER NOT NULL DEFAULT 0,
  last_reset_date TEXT    NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS character_market_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_name          TEXT    NOT NULL,
  character_name   TEXT    NOT NULL,
  normalized_key   TEXT    NOT NULL,
  category         TEXT    NOT NULL,
  avg_weight_ratio REAL    NOT NULL,
  sample_count     INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_stats_key ON character_market_stats(normalized_key, category);

CREATE TABLE IF NOT EXISTS market_price_cache (
  cache_key           TEXT PRIMARY KEY,
  ip_name             TEXT NOT NULL,
  normalized_char     TEXT NOT NULL,
  series_key          TEXT NOT NULL DEFAULT '',
  item_type           TEXT NOT NULL DEFAULT '通用',
  market_price_median REAL,
  market_price_range  TEXT,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  sources             TEXT NOT NULL DEFAULT '[]',
  pricing_tier        TEXT NOT NULL,
  freshness           TEXT NOT NULL,
  query_used          TEXT NOT NULL DEFAULT '',
  cached_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cache_exp ON market_price_cache(expires_at);

CREATE TABLE IF NOT EXISTS market_contributions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_code TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  ip_name    TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detect_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_code     TEXT NOT NULL DEFAULT '',
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  detected_count INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  error_msg      TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_orders (
  id                       TEXT PRIMARY KEY,
  share_code               TEXT NOT NULL UNIQUE,
  title                    TEXT NOT NULL,
  ip_name                  TEXT NOT NULL,
  owner_token              TEXT NOT NULL,
  annotated_image_data_url TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
  source_item_id TEXT,
  label          TEXT NOT NULL,
  price          REAL NOT NULL,
  prepaid_price  REAL,
  total_qty      INTEGER NOT NULL,
  claimed_qty    INTEGER NOT NULL DEFAULT 0,
  tag            TEXT NOT NULL DEFAULT '',
  box_json       TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_order ON group_order_items(order_id);

CREATE TABLE IF NOT EXISTS group_claims (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES group_order_items(id) ON DELETE CASCADE,
  buyer_name    TEXT NOT NULL,
  buyer_contact TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  claim_token   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_claims_order ON group_claims(order_id);
CREATE INDEX IF NOT EXISTS ix_claims_item  ON group_claims(item_id);
CREATE INDEX IF NOT EXISTS ix_claims_token ON group_claims(claim_token);
`;
