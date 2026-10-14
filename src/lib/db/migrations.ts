/**
 * 数据库迁移定义。
 *
 * 字段名是跨模块契约，修改需同步 research/impl-architecture.md 第 4 节。
 * 全部时间以 UTC ISO8601 字符串存储；布尔值以 INTEGER 0/1 存储。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_INIT = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  namespace TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  namespace TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS needs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  alias TEXT,
  origin TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  selected INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0,
  cache_ttl_seconds INTEGER NOT NULL DEFAULT 10,
  next_poll_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_catalog (
  id TEXT PRIMARY KEY,
  name TEXT,
  alias TEXT,
  origin TEXT NOT NULL,
  raw TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bulletins (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_ns TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT,
  price REAL,
  brand TEXT,
  mall TEXT,
  published_at TEXT,
  payload TEXT NOT NULL,
  content_version TEXT NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_ns, source_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at TEXT NOT NULL,
  lease_until TEXT,
  lease_owner TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(payload_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  bulletin_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  bulletin_id TEXT NOT NULL,
  need_id TEXT NOT NULL,
  need_name TEXT NOT NULL,
  need_note TEXT NOT NULL,
  need_version INTEGER NOT NULL,
  config_version INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  result TEXT NOT NULL,
  probabilities TEXT,
  confidence REAL,
  raw_answer TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bulletin_id, need_id, rule_version)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  bulletin_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  lease_owner TEXT,
  http_status INTEGER,
  biz_code TEXT,
  response TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(notification_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_evaluations_bulletin ON evaluations(bulletin_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON deliveries(notification_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_channels_next_poll ON channels(selected, available, next_poll_at);
`;

export const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: V1_INIT,
  },
];
