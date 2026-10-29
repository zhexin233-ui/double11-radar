import type Database from "better-sqlite3";

/**
 * 数据库迁移定义。
 *
 * 字段名是跨模块契约，修改需同步
 * `.trellis/tasks/archive/2026-10/10-14-jev-key-pool-usage-records/design.md`
 * 第 2 节以及读写它的仓库（`src/lib/db/repos/*`）。
 * 全部时间以 UTC ISO8601 字符串存储；布尔值以 INTEGER 0/1 存储。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * 可选的数据迁移，在同一个 `BEGIN IMMEDIATE` 事务内、`sql` 之后执行。
   * 只用于无法用纯 SQL 表达的搬迁（例如把旧单密钥密文移动到 Key 池 namespace）。
   */
  run?: (db: Database.Database) => void;
}

/** 旧版单密钥的密文 namespace（V1 唯一写入的 Jev 凭据位置）。 */
export const LEGACY_JEV_SECRET_NAMESPACE = "jev.apiKey";/** 迁移后旧单密钥在 Key 池中的固定 id，兼容层始终映射到它。 */
export const LEGACY_JEV_KEY_ID = "legacy-default";
/** 旧单密钥迁移后的密文 namespace（与旧 namespace 区分，避免误读）。 */
export const LEGACY_JEV_KEY_NAMESPACE = "jev.key.legacy-default";

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

/**
 * V2：Jev 多密钥池与调用账本。
 *
 * - `jev_api_keys`：密钥元数据（label/generation/健康计数），密文仍存 `secrets`；
 * - `jev_requests`：每一次**实际**上游调用（含后台/连接测试/试判与每次重试）的账本；
 *   `result_recorded_at` 保证真实结果只能落账一次，租约回收后迟到结果可补写同一行。
 */
const V2_KEYS_AND_LEDGER = `
CREATE TABLE IF NOT EXISTS jev_api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  secret_namespace TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_used_at TEXT,
  cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jev_requests (
  id TEXT PRIMARY KEY,
  upstream_request_id TEXT,
  key_id TEXT,
  key_label TEXT,
  key_generation INTEGER,
  purpose TEXT NOT NULL,
  bulletin_id TEXT,
  job_id TEXT,
  requested_model TEXT NOT NULL,
  response_model TEXT,
  provider_origin TEXT,
  config_version INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  lease_until TEXT,
  result_recorded_at TEXT,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  price_version TEXT,
  input_rate_nanos_per_token INTEGER,
  estimated_usd_nanos INTEGER,
  cost_status TEXT NOT NULL DEFAULT 'unknown',
  unknown_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_jev_requests_status_lease ON jev_requests(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_jev_requests_key ON jev_requests(key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_jev_requests_started ON jev_requests(started_at);
CREATE INDEX IF NOT EXISTS idx_jev_requests_result ON jev_requests(result_recorded_at);
`;

/**
 * 把 V1 的单密钥密文原样搬到 Key 池兼容 namespace，并登记默认启用的旧 Key 元数据。
 * 不解密、不重加密、不写日志；没有旧密钥时不创建空条目。
 */function migrateLegacyJevKey(db: Database.Database): void {
  const legacy = db
    .prepare("SELECT ciphertext, updated_at FROM secrets WHERE namespace = ?")
    .get(LEGACY_JEV_SECRET_NAMESPACE) as
    | { ciphertext: string; updated_at: string }
    | undefined;
  if (!legacy) return;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO jev_api_keys (
       id, label, secret_namespace, generation, enabled, consecutive_failures,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, 0, ?, ?)`,
  ).run(
    LEGACY_JEV_KEY_ID,
    "旧版单密钥（迁移）",
    LEGACY_JEV_KEY_NAMESPACE,
    legacy.updated_at ?? now,
    now,
  );
  db.prepare(
    `INSERT OR IGNORE INTO secrets (namespace, ciphertext, updated_at)
     SELECT ?, ciphertext, updated_at FROM secrets WHERE namespace = ?`,
  ).run(LEGACY_JEV_KEY_NAMESPACE, LEGACY_JEV_SECRET_NAMESPACE);
  db.prepare("DELETE FROM secrets WHERE namespace = ?").run(
    LEGACY_JEV_SECRET_NAMESPACE,
  );
}

/**
 * V3：三种自动处理模式。
 *
 * - `evaluation_runs`：一次采集的模式/规则/需求快照；
 * - `evaluation_batch_parts`：batch_gate 子批及其唯一终态；
 * - `bulletin_processing`：每个新增线报的本地处理阶段/过滤来源（不伪造模型答案）；
 * - `jev_requests` 追加 run/part 关联列，旧账本行为 NULL，不回算。
 */
const V3_EVALUATION_MODES = `
CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  source_ns TEXT NOT NULL,
  evaluation_mode TEXT NOT NULL,
  strategy_config_version INTEGER NOT NULL,
  regex_rules_json TEXT,
  need_snapshots_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_batch_parts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  gate_result TEXT,
  gate_request_id TEXT,
  fallback_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_batch_parts_run
  ON evaluation_batch_parts(run_id, ordinal);

CREATE TABLE IF NOT EXISTS bulletin_processing (
  bulletin_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  batch_part_id TEXT,
  position INTEGER NOT NULL,
  stage TEXT NOT NULL,
  screening_source TEXT,
  screening_reason TEXT,
  gate_request_id TEXT,
  matched_rule_index INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processing_run ON bulletin_processing(run_id);
CREATE INDEX IF NOT EXISTS idx_processing_part ON bulletin_processing(batch_part_id);
CREATE INDEX IF NOT EXISTS idx_processing_stage ON bulletin_processing(stage);

ALTER TABLE jev_requests ADD COLUMN evaluation_run_id TEXT;
ALTER TABLE jev_requests ADD COLUMN batch_part_id TEXT;
CREATE INDEX IF NOT EXISTS idx_jev_requests_run ON jev_requests(evaluation_run_id);
CREATE INDEX IF NOT EXISTS idx_jev_requests_part ON jev_requests(batch_part_id);
`;

/**
 * V4：逐需求判定追溯。
 *
 * 追加 nullable 追溯列，便于区分模型的原始选择与业务确认结果；
 * 旧行保持 NULL（显示「策略未记录」），不回填、不伪造，也不改变唯一键与 upsert 语义。
 * `jev_request_id` 仅记录成功响应对应的实际调用账本 ID，不做级联删除。
 */
const V4_MATCH_CONFIRMATION_TRACE = `
ALTER TABLE evaluations ADD COLUMN model_result TEXT;
ALTER TABLE evaluations ADD COLUMN decision_reason TEXT;
ALTER TABLE evaluations ADD COLUMN decision_policy_version TEXT;
ALTER TABLE evaluations ADD COLUMN decision_policy_json TEXT;
ALTER TABLE evaluations ADD COLUMN jev_request_id TEXT;
`;

/**
 * V5：需求分组支持与存量需求迁移。
 *
 * 引入 need_groups 表，并在 needs 表追加 group_id 外键列；
 * 为存量无 group_id 的需求自动创建并挂载到「默认分组」，确保向下兼容。
 */
const V5_NEED_GROUPS = `
CREATE TABLE IF NOT EXISTS need_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  order_num INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE needs ADD COLUMN group_id TEXT REFERENCES need_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_needs_group_id ON needs(group_id);
`;

export const DEFAULT_NEED_GROUP_ID = "default";
export const DEFAULT_NEED_GROUP_NAME = "默认分组";

function migrateDefaultNeedGroup(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO need_groups (id, name, enabled, order_num, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)`,
  ).run(DEFAULT_NEED_GROUP_ID, DEFAULT_NEED_GROUP_NAME, now, now);

  db.prepare(
    `UPDATE needs SET group_id = ? WHERE group_id IS NULL OR group_id = ''`,
  ).run(DEFAULT_NEED_GROUP_ID);
}

/**
 * V6：模型渠道（model_channels）与 Key/Request 渠道关联。
 */
const V6_MODEL_CHANNELS = `
CREATE TABLE IF NOT EXISTS model_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_channels_base_model ON model_channels(base_url, model);

ALTER TABLE jev_api_keys ADD COLUMN channel_id TEXT;
ALTER TABLE jev_api_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_jev_keys_channel ON jev_api_keys(channel_id);
CREATE INDEX IF NOT EXISTS idx_jev_keys_base_url ON jev_api_keys(base_url);

ALTER TABLE jev_requests ADD COLUMN channel_id TEXT;
ALTER TABLE jev_requests ADD COLUMN base_url TEXT;
CREATE INDEX IF NOT EXISTS idx_jev_requests_channel ON jev_requests(channel_id);
CREATE INDEX IF NOT EXISTS idx_jev_requests_base_url ON jev_requests(base_url);
`;

const INITIAL_CHANNELS = [
  {
    id: "channel-commandcode",
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider",
    model: "typesafe/jev",
    timeoutMs: 30000,
  },
  {
    id: "channel-typesafe",
    name: "TypeSafe 官方",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 30000,
  },
  {
    id: "channel-laya",
    name: "本地 Laya",
    baseUrl: "http://127.0.0.1:8000",
    model: "laya-9b",
    timeoutMs: 30000,
  },
];

function migrateModelChannels(db: Database.Database): void {
  const now = new Date().toISOString();
  // 查找当前 settings 中的 jev 配置
  let currentBaseUrl = "https://api.typesafe.ai";
  let currentModel = "jev-latest";
  const row = db
    .prepare("SELECT value FROM settings WHERE namespace = 'jev'")
    .get() as { value: string } | undefined;
  if (row) {
    try {
      const cfg = JSON.parse(row.value) as { baseUrl?: string; model?: string };
      if (cfg.baseUrl) currentBaseUrl = cfg.baseUrl;
      if (cfg.model) currentModel = cfg.model;
    } catch {
      // ignore
    }
  }

  // 插入内置预设
  for (const ch of INITIAL_CHANNELS) {
    const isActive =
      ch.baseUrl.replace(/\/+$/, "") === currentBaseUrl.replace(/\/+$/, "") ? 1 : 0;
    db.prepare(
      `INSERT OR IGNORE INTO model_channels (
         id, name, base_url, model, timeout_ms, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ch.id, ch.name, ch.baseUrl, ch.model, ch.timeoutMs, isActive, now, now);
  }

  // 确保至少有一个渠道被激活
  const activeCount = db
    .prepare("SELECT COUNT(*) AS count FROM model_channels WHERE is_active = 1")
    .get() as { count: number };
  if (activeCount.count === 0) {
    // 若当前配置不是预设中的，则为当前配置创建一个自定义默认渠道
    const defaultId = "channel-current";
    db.prepare(
      `INSERT OR REPLACE INTO model_channels (
         id, name, base_url, model, timeout_ms, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(defaultId, "默认渠道", currentBaseUrl, currentModel, 30000, now, now);
  }

  // 获取当前活动渠道
  const activeChannel = db
    .prepare("SELECT id, base_url FROM model_channels WHERE is_active = 1 LIMIT 1")
    .get() as { id: string; base_url: string } | undefined;

  const activeChannelId = activeChannel ? activeChannel.id : "channel-typesafe";
  const activeChannelBaseUrl = activeChannel ? activeChannel.base_url : currentBaseUrl;

  // 将所有存量密钥绑定至活动渠道
  db.prepare(
    `UPDATE jev_api_keys
     SET channel_id = ?, base_url = ?
     WHERE channel_id IS NULL OR base_url = ''`,
  ).run(activeChannelId, activeChannelBaseUrl);

  // 将存量账本记录填充 baseUrl
  db.prepare(
    `UPDATE jev_requests
     SET channel_id = ?, base_url = ?
     WHERE channel_id IS NULL`,
  ).run(activeChannelId, activeChannelBaseUrl);
}

const V7_SYSTEM_ALERTS = `
CREATE TABLE system_alerts (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type = 'key_auto_disabled'),
  key_id TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  key_label TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  http_status INTEGER,
  error_category TEXT NOT NULL CHECK(error_category IN ('auth','rate_limit','upstream','network','invalid_response','unknown')),
  dispatch_status TEXT NOT NULL DEFAULT 'pending' CHECK(dispatch_status IN ('pending','dispatched','no_channels')),
  dispatched_at TEXT,
  UNIQUE(event_type, key_id, key_generation)
);
CREATE TABLE system_alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES system_alerts(id),
  channel TEXT NOT NULL CHECK(channel IN ('bark','feishu')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','failed','succeeded','disabled','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  http_status INTEGER,
  biz_code TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(alert_id, channel)
);
CREATE INDEX system_alert_dispatch ON system_alerts(dispatch_status, occurred_at);
CREATE INDEX system_alert_delivery_due ON system_alert_deliveries(status, run_at);
`;

const V8_KEY_AUTO_REENABLE = `
ALTER TABLE jev_api_keys ADD COLUMN auto_reenable_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_reenable_enabled IN (0,1));
ALTER TABLE jev_api_keys ADD COLUMN auto_reenable_minutes INTEGER NOT NULL DEFAULT 5 CHECK(typeof(auto_reenable_minutes) = 'integer' AND auto_reenable_minutes BETWEEN 1 AND 1440);
ALTER TABLE jev_api_keys ADD COLUMN auto_disabled_at TEXT;
ALTER TABLE jev_api_keys ADD COLUMN auto_reenable_at TEXT;

CREATE TABLE system_alerts_v8 (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('key_auto_disabled','key_auto_reenabled')),
  key_id TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  key_label TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  http_status INTEGER,
  error_category TEXT CHECK(
    (event_type = 'key_auto_disabled' AND error_category IS NOT NULL AND error_category IN ('auth','rate_limit','upstream','network','invalid_response','unknown'))
    OR (event_type = 'key_auto_reenabled' AND error_category IS NULL)
  ),
  dispatch_status TEXT NOT NULL DEFAULT 'pending' CHECK(dispatch_status IN ('pending','dispatched','no_channels')),
  dispatched_at TEXT,
  UNIQUE(event_type, key_id, key_generation)
);
CREATE TABLE system_alert_deliveries_v8 (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES system_alerts_v8(id),
  channel TEXT NOT NULL CHECK(channel IN ('bark','feishu')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','failed','succeeded','disabled','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  http_status INTEGER,
  biz_code TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(alert_id, channel)
);
INSERT INTO system_alerts_v8 SELECT * FROM system_alerts;
INSERT INTO system_alert_deliveries_v8 SELECT * FROM system_alert_deliveries;
-- 先移除旧子表，保证外键开启时也能安全重建父表。
DROP TABLE system_alert_deliveries;
DROP TABLE system_alerts;
ALTER TABLE system_alerts_v8 RENAME TO system_alerts;
ALTER TABLE system_alert_deliveries_v8 RENAME TO system_alert_deliveries;
CREATE INDEX system_alert_dispatch ON system_alerts(dispatch_status, occurred_at);
CREATE INDEX system_alert_delivery_due ON system_alert_deliveries(status, run_at);
`;

export const migrations: Migration[] = [
  // 历史迁移保持不变，新告警独立于线报清理与投递统计。
  {
    version: 1,
    name: "init",
    sql: V1_INIT,
  },
  {
    version: 2,
    name: "jev_key_pool_and_request_ledger",
    sql: V2_KEYS_AND_LEDGER,
    run: migrateLegacyJevKey,
  },
  {
    version: 3,
    name: "evaluation_modes_runs_batch_parts_processing",
    sql: V3_EVALUATION_MODES,
  },
  {
    version: 4,
    name: "evaluations_match_confirmation_trace",
    sql: V4_MATCH_CONFIRMATION_TRACE,
  },
  {
    version: 5,
    name: "need_groups_and_needs_association",
    sql: V5_NEED_GROUPS,
    run: migrateDefaultNeedGroup,
  },
  {
    version: 6,
    name: "model_channels_and_key_provider_partition",
    sql: V6_MODEL_CHANNELS,
    run: migrateModelChannels,
  },
  { version: 7, name: "system_key_failure_alerts", sql: V7_SYSTEM_ALERTS },
  { version: 8, name: "key_auto_reenable_and_recovery_events", sql: V8_KEY_AUTO_REENABLE },
];
