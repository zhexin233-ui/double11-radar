# Database Guidelines

> Schema, migrations, transactions and crash recovery.

---

## Engine and connection

`src/lib/db/client.ts` — `getDb(dbPath?)` returns a process singleton:

```ts
instance.pragma("journal_mode = WAL");
instance.pragma("busy_timeout = 5000");
instance.pragma("foreign_keys = ON");
```

`better-sqlite3` is synchronous. Repos are synchronous on purpose; do not introduce `await`
between a read and the write that depends on it unless both are inside one transaction.

## Migrations

`src/lib/db/migrations.ts` exports an ordered `Migration[]`; `migrate.ts` applies each version once:

```ts
export function migrate(db, list = migrations): { applied: number[] }
```

- Wrapped in `db.transaction(...).immediate()` → `BEGIN IMMEDIATE`, so two processes starting at
  once serialize instead of racing.
- Called from `src/instrumentation.ts` (web) and from `startWorker()` (worker). Idempotent.
- **Field names are a cross-module contract.** Changing a column means updating the current
  task's `design.md` 第 2 节（`.trellis/tasks/10-14-jev-key-pool-usage-records/design.md`）
  and every repo that reads it.

## Conventions

| Rule | Reason |
| --- | --- |
| Store times as UTC ISO8601 strings | Sorting/filtering works lexicographically; browser formats for display |
| Store booleans as INTEGER 0/1 | better-sqlite3 **throws** on boolean bind params |
| `price` missing → `NULL`, never `0` | `null` means "source has no price"; `0` would mean free |
| Deduplicate by `(source, source_ns, source_id)` | Different channels are different identity spaces; titles are not identity |
| Use `INSERT OR IGNORE` for seen-items | Establishing a baseline must never rewrite existing rows |

> **Warning**: `better-sqlite3` rejects booleans and `undefined`.
> `db.prepare(...).run({ enabled: true })` throws
> `SQLite3 can only bind numbers, strings, bigints, buffers, and null`.
> Convert at the repo boundary (`enabled ? 1 : 0`).

## Idempotency and leases

```ts
// Create exactly once
enqueueJob(db, { kind, payloadKey: "evaluate:<bulletinId>", payload, maxAttempts })
// -> INSERT OR IGNORE + UNIQUE(payload_key)

// Claim with a lease (transaction + status guard)
claimJob(db, owner, leaseMs, now, kind?)            // pending -> leased
reclaimExpiredLeases(db, now)                        // expired leased -> pending
failJob(db, id, error, now)                          // attempts++, backoff, or dead

claimDelivery(db, owner, leaseMs, now)               // pending|failed -> sending
markDeliveryResult(db, { id, status, retryAt, ... }) // retryAt reuses lease_until
```

Rules:

- Never claim by `SELECT` then `UPDATE` outside a transaction; the atomic `UPDATE ... WHERE
  status = 'pending'` is what makes two workers safe.
- `payload_key` must embed the stable identity (`evaluate:<id>`, `deliver:<id>`) so a replayed
  round cannot create a duplicate.
- A `succeeded` delivery is never re-claimable — local replay must not resend.
- **Config errors must not kill the job.** `failJob(db, id, error, now, { permanentRetry: true })`
  keeps `status = 'pending'`, sets `run_at = now + CONFIG_ERROR_RETRY_SECONDS` (300s) and only
  accumulates `attempts` for observability. Use it for failures the operator will fix in the UI
  (Jev not configured, invalid credentials); otherwise queued bulletins would permanently stay
  un-evaluated after the operator fixes the configuration.

```ts
// src/lib/worker/evaluator.ts
const isConfigError =
  error instanceof JevError && error.code !== null && JE_CONFIG_ERROR_CODES.has(error.code);
failJob(db, job.id, message, now, { permanentRetry: isConfigError });
```

## Good / Base / Bad

- **Good**: first channel snapshot inserts `baseline = 1` rows and enqueues nothing.
- **Base**: second round inserts a new row with `baseline = 0` and enqueues one `evaluate` job.
- **Bad**: `INSERT OR REPLACE` during baseline — it would delete evaluations/deliveries attached
  to the existing row.

## Jev Key 池与调用账本（code-spec）

V2 增量迁移新增两张表（`src/lib/db/migrations.ts` 的 `V2_KEYS_AND_LEDGER`），保留 V1 不动。
字段名与列语义是跨模块契约，改动需同步本任务 `design.md` 第 2 节与所有读取的仓库。

### 表契约

`jev_api_keys`（Key 元数据；密文仍存 `secrets`，每 Key 一个 namespace）：

| 列 | 语义 |
| --- | --- |
| `id` / `label` | 本地标识与展示名；账本按 `id`/`label` 存非敏感快照 |
| `secret_namespace` | 唯一，指向 `secrets` 中的密文（`jev.key.<id>`，`src/lib/service/jev-keys.ts`） |
| `generation` | 替换密钥/手动恢复时 +1，用于隔离旧请求的迟到结果 |
| `enabled` | 0/1；0 不再参与调度，迟到成功也不能自动启用 |
| `disabled_reason` / `last_error` | 中文禁用原因与清洗后的最近错误 |
| `consecutive_failures` | 连续实际请求失败数；成功清 0，达 3 自动禁用（`JE_KEY_FAILURE_THRESHOLD`） |
| `cooldown_until` | 429/529 的每 Key 冷却截止时间（UTC ISO8601） |
| `last_used_at` | 最近被选中调用的时间，用于「最久未用」排序 |

`jev_requests`（一次**实际**上游调用 = 一行；后台判断/连接测试/试判与每次重试分别记账）：

| 列 | 语义 |
| --- | --- |
| `status` | `in_flight` / `succeeded` / `failed` / `interrupted` |
| `result_recorded_at` | 真实结果已落账的唯一标记；NULL 表示尚未收到真实结果 |
| `key_id` / `key_label` / `key_generation` | 调用时的 Key 非敏感快照；Key 删除不级联，历史保留 |
| `purpose` | `evaluate` / `test` / `dry_run` |
| `requested_model` / `response_model` / `provider_origin` / `config_version` | 计价与追溯所需的调用快照 |
| `input_tokens` / `output_tokens` | 上游报告用量；缺失/非法为 NULL（未知），绝不用 0 冒充 |
| `estimated_usd_nanos` | 已知时的整数纳美元估算（42 ns/输入 Token）；未知为 NULL |
| `cost_status` | `known` / `unknown` |
| `unknown_reason` | 未知计价的中文原因（未知模型/provider/缺输入用量等） |
| `price_version` / `input_rate_nanos_per_token` | 请求发生时的费率快照，更新价格不改写历史行 |
| `error_code` / `error_message` / `http_status` | 失败分类与清洗后的中文错误 |
| `lease_until` | 预留租约；过期回收为 `interrupted` 并释放容量 |

### 迁移规则

- **V2 增量迁移**，不修改已应用的 V1；`migrate()` 必须在 `BEGIN IMMEDIATE` 事务**内**读取
  `schema_migrations`（`src/lib/db/migrate.ts`）。web/worker 同时启动时写锁串行，
  第二个进程读到的是第一个提交后的版本，**V2 只应用一次**。
- 旧 `secrets('jev.apiKey')` 在迁移事务中原样搬到 `jev.key.legacy-default` 并删除旧 namespace
  （`migrateLegacyJevKey`）：**不解密、不重加密、不写日志**；没有旧密钥时不创建空条目，
  重复迁移不重复创建。
- 回退到旧代码必须恢复与之匹配的数据库备份；不能只回退镜像。

### 事务与幂等

- Key 新增/替换/清除 + 密文更新 + `settings('jev').version` 自增必须在**同一事务**内
  （`src/lib/service/jev-keys.ts` 的 `addJevKey` / `updateJevKeySettings` / `removeJevKey`）；
  只更新普通 Jev 配置不得重置 Key 计数或误启用已禁用 Key。
- 真实结果落账以 `result_recorded_at IS NULL` 为唯一条件原子更新，保证用量/费用/健康计数
  **只记一次**（`src/lib/db/repos/jev-requests.ts` 的 `completeJevRequest`）。
- `interrupted`（租约到期回收）释放容量但 `result_recorded_at` 仍为 NULL，允许迟到的真实响应
  补写同一行一次；健康计数与账本在同一事务写入。
- 迟到/旧 `generation` 的结果不得改写新 generation 状态，也不得重新启用已禁用/人工停用的 Key
  （`recordJevKeySuccess` / `recordJevKeyFailure` 都带 `generation` 与 `enabled = 1` 守卫）。

### 调度（预留）

`reserveJevCall` 在单个 `BEGIN IMMEDIATE` 事务里按顺序执行：

1. 回收超期预留（`reclaimExpiredRequestReservations` → `interrupted`，容量释放、费用未知）；
2. 读取 Jev 配置与启用/可解密且非冷却的 Key；
3. 检查**全局容量**：所有入口共享的有效 `in_flight` 数 < 配置 `concurrency`
   （`countActiveInFlight`），否则 `busy`，不发请求、不计费；
4. 检查共享退避与每 Key 冷却；
5. 按「在途最少 → `last_used_at` 最旧 → `id` 稳定」选 Key，写 `in_flight` 预留并更新
   `last_used_at`。

> **Warning**: 预留事务内**禁止** `await` 网络。事务只做同步状态选择与写预留，
> 网络调用在事务之外（`callJevWithLedger`）。`concurrency` 是全局上限，**不是**
> 「每 Key 并发 × Key 数」；默认 1，范围 1—8。

### 429 / 529 共享退避

- 解析 `Retry-After`（秒数或 HTTP 日期，`parseRetryAfterMs`）；优先服务端等待时间，
  否则按有限指数退避（`JE_RATE_LIMIT_BASE_BACKOFF_MS` → `JE_RATE_LIMIT_MAX_BACKOFF_MS`）。
- 同时写 `settings('jev.cooldown')`（`src/lib/db/repos/jev-cooldown.ts`，web/worker 共享）
  与对应 Key 的 `cooldown_until`，避免轮换 Key 绕过可能共享的账号限额。
- 429/529 **同时**计入「连续实际请求失败」，达到 3 次仍会禁用该 Key。

### jobs 租约与 owner 守卫

- `completeJob` / `failJob` 支持可选 `owner`：只有仍持有该次租约
  （`lease_owner = ? AND status = 'leased'`）才能改写任务状态，避免旧调用覆盖新 owner。
- `requeueJob(db, id, owner, error, runAt, now)` 用于「**未发出上游请求**」的可恢复情况
  （容量满、共享退避、无可用 Key、丢失 ownership）：放回 `pending` 但**不累计** `attempts`。
- 线报本身的（实际请求）失败仍走 `failJob`；配置类问题继续用
  `failJob(..., { permanentRetry: true })` 固定 300s 重排、不置 `dead`。
- 判断/通知等业务写入前必须用 `isJobOwnedBy(db, id, owner)` 核对仍持有租约。

### Good / Base / Bad（Key 池与账本）

- **Good**：一次 evaluator 调用按执行槽 `claimJob`，落判断前 `isJobOwnedBy` 通过，成功
  `completeJob(owner)`；容量满时 `requeueJob` 5s 后重排且 `attempts` 不变。
- **Base**：一次请求成功但响应缺 `input_tokens` → 账本 `cost_status = 'unknown'`、
  `estimated_usd_nanos = NULL`；判断本身仍然有效。
- **Bad**：在预留事务里 `await fetch`；或用旧 owner 的迟到结果覆盖新 owner 的判断/通知/
  已禁用 Key 的状态。

## Required tests

- `tests/db/repos.test.ts` — insert-if-absent is idempotent; lease expiry returns a job to
  `pending`; `max_attempts` produces `dead`; a succeeded delivery is not re-claimed.
- `tests/db/migrate.test.ts` — running `migrate()` twice applies nothing the second time; V2
  只应用一次，旧单密钥密文搬迁幂等且无旧密钥不建空条目。
- `tests/service/config.test.ts` — secrets survive reopening the database with the same key.
- `tests/service/jev-keys.test.ts` — 三次失败禁用、成功清零、替换/恢复 generation 隔离、
  迟到结果不改写新 generation；清除/替换单 Key 不影响其它 Key 或历史账本。
- `tests/service/jev-requests.test.ts` — `result_recorded_at` 保证真实结果只落账一次；
  `interrupted` 允许迟到结果补写一次；容量满/退避不计失败不计费。
- `tests/service/jev-usage.test.ts`、`tests/jev/pricing.test.ts` — 汇总与未知计价：
  1,000,000 输入 = $0.042、输出免费、缺失输入为未知、极小正数不显示为 $0.00。
- `tests/worker/evaluator-lease.test.ts` — owner 守卫；未发出上游请求的重排不累计 `attempts`。
