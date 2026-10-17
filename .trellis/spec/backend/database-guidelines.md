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
- **Field names are a cross-module contract.** Changing a column means updating the archived
  design of record's `design.md` 第 2 节
  （`.trellis/tasks/archive/2026-10/10-14-jev-key-pool-usage-records/design.md`）and every
  repo that reads it.

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
if (error instanceof JevCallBlockedError && error.isConfigProblem) {
  failJob(db, job.id, error.message, now, { permanentRetry: true, owner });
}
```

## Good / Base / Bad

- **Good**: first channel snapshot inserts `baseline = 1` rows and enqueues nothing.
- **Base**: second round inserts a new row with `baseline = 0` and enqueues one `evaluate` job.
- **Bad**: `INSERT OR REPLACE` during baseline — it would delete evaluations/deliveries attached
  to the existing row.

## Jev Key 池与调用账本（code-spec）

V2 增量迁移新增两张表（`src/lib/db/migrations.ts` 的 `V2_KEYS_AND_LEDGER`），保留 V1 不动。
字段名与列语义是跨模块契约，改动需同步归档设计文档 `design.md` 第 2 节与所有读取的仓库。

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
- `tests/db/repos.test.ts` / `tests/db/migrate.test.ts` — V4 追溯列可空、往返、同键重试覆盖与重复迁移幂等（见下节）。
- `tests/jev/match-policy.test.ts` — 分布合法性、0.80 边界与原因码矩阵（见下节）。

## Scenario: 三模式自动处理（run / 子批 / 处理记录）

### 1. Scope / Trigger

- 触发：新增 V3 DDL（三张表 + 账本关联列）、`JobKind`/`JevRequestPurpose` 扩展、记录页状态优先级变化。
- 策略只在**后台自动处理**层生效；连接测试与需求试判仍直接调用统一请求服务，不受预筛影响。

### 2. Signatures

- 迁移：`src/lib/db/migrations.ts` 的 `V3_EVALUATION_MODES`（追加版本 3，不改 V1/V2）。
- 仓库：`src/lib/db/repos/evaluation-runs.ts`
  - `insertEvaluationRun` / `getEvaluationRun`
  - `insertBatchPart` / `getBatchPart` / `listBatchPartsByRun`
  - `insertProcessing` / `getProcessing` / `listProcessingByPart` / `updateProcessing`
  - `excludeBatchPart` / `expandBatchPart`（都只允许 `pending → 终态`，返回是否命中）
- 任务：`JobKind` 增加 `screen_batch`；payload key `screen_batch:<partId>`。
- 账本：`JevRequestPurpose` 增加 `batch_gate`；`jev_requests` 增加 `evaluation_run_id`、`batch_part_id`。

### 3. Contracts

`evaluation_runs`（采集时冻结模式/规则/需求快照）：

| 列 | 语义 |
| --- | --- |
| `evaluation_mode` | `individual` / `batch_gate` / `regex_gate` |
| `strategy_config_version` | 采集时 `settings('jev').version`，仅追溯用 |
| `regex_rules_json` | 仅 `regex_gate` 非空：该 run 的全局规则快照 |
| `need_snapshots_json` | 仅 `batch_gate` 非空：全部启用需求 `{id,name,note,enabled,version}` 快照；门控与展开都使用它 |

`evaluation_batch_parts`：`state ∈ pending|excluded|expanded`，`UNIQUE(run_id, ordinal)`；`gate_result`/`gate_request_id`/`fallback_reason` 可空。

`bulletin_processing`（一个新增来源条目一行）：
`stage ∈ pending|ready|filtered|evaluated|failed|skipped_no_needs`；
`screening_source ∈ batch_gate|regex_gate|NULL`；`matched_rule_index` 仅正则命中时记录；`gate_request_id` 关联门控账本行。

`BULLETIN_DISPLAY_STATUS_SQL` 优先级（列表/详情/计数共用同一表达式）：
`baseline > matched > failed > uncertain > 已有 evaluation 的 not_matched > processing.stage='filtered' 的 not_matched > pending`。
`processing.stage='failed'` 也归入 failed；本地过滤不得伪造模型 `evaluations`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 批次合法且明确「全批对全部需求均不相关」 | part=`excluded`、成员 `filtered`（source=batch_gate）、无 evaluation/通知，账本仅 1 行门控 |
| 批次命中 / 可疑 | part=`expanded`、成员 `ready`、幂等建 `evaluate:<id>`（使用 run 需求快照） |
| 门控失败 / 缺题 / 非法答案 / 超体积 / 连接语义（baseUrl·model）变化 | part=`expanded` + 中文 `fallback_reason`，全成员逐条 |
| 门控阻塞（busy / cooldown / no_key） | part 保持 `pending`，不展开、不绕限流 |
| 门控 owner 失效 | 迟到请求仍记真实用量/Key 状态，但不改 part/成员 |
| 正则未匹配 | 成员 `filtered`（source=regex_gate），不写 `jev_requests` |
| 正则异常 / 超时 / 超边界 / 规则为空 | 成员 `ready` + `screening_reason` 回退原因，继续逐条 |
| 没有启用需求 | 成员 `skipped_no_needs`，不请求模型，不算「未命中」 |

### 5. Good / Base / Bad Cases

- Good：采集 `apply.immediate()` 事务内读模式/规则/需求并建 run；子批 ≤20 条且完整门控请求 ≤16 KiB；统一请求服务在预留事务内按本次实际 `timeoutMs` 校准 job 租约。
- Base：正则规则为空 → 回退逐条并记录原因。
- Bad：把门控失败/非法答案当 `not_matched` 整批结束；用 `processing` 冒充模型逐条结论；在一个门控租约内串行跑 N 次精判。

### 6. Tests Required

- `tests/db/evaluation-runs.test.ts` — excluded/expanded 终态唯一、成员阶段投影、`updateProcessing` 保留未提交字段。
- `tests/db/migrate.test.ts` — V3 表/列存在、重复迁移幂等。
- `tests/worker/collector-modes.test.ts` — 采集事务内建 run/part/processing；batch_gate 需求快照、regex_gate 规则快照。
- `tests/worker/three-modes.test.ts` — N 条发 N 次；全否仅 1 次；命中/可疑 N+1 次且全成员；非法答案回退；无 Key 保持 pending；连接语义变化否决不生效；正则 pass/filter/fallback。
- `tests/service/jev-requests.test.ts` — batch_gate 单行账本 + run/part 关联；预留事务内租约校准；失去 owner 返回 `lease_lost` 且不发请求、不写账本。
- `tests/jev/batch-gate.test.ts`、`tests/regex/rules.test.ts` — 三态严格解析、装箱不丢成员/不截断、线程 ready/validate/match 与超限回退。

### 7. Wrong vs Correct

#### Wrong

```ts
// 在采集事务外或整轮缓存里读模式，门控租约内串行跑全批精判
const mode = cachedMode;
claimJob(db, owner, leaseMs, "screen_batch");
for (const member of members) await evaluateJob(...);
```

#### Correct

```ts
// 采集事务内读模式/规则/需求并建 run；门控只发一次，展开为独立成员任务
const jevConfig = getJevConfig(db);
insertEvaluationRun(db, { ...snapshot });
enqueueJob(db, { kind: "screen_batch", payloadKey: `screen_batch:${partId}`, payload: { partId } });
// 展开时只 enqueue evaluate:<id>，由统一 claim 循环继续领取
```

---

## Scenario: 匹配确认门控与判定追溯（V4）

### 1. Scope / Trigger

- 触发：新增 V4 DDL（`evaluations` 5 个可空追溯列）、`DecisionReason` 枚举、
  `src/lib/jev/match-policy.ts` 纯决策模块，以及「通知只含本次确认项」的语义收敛。
- 问题：模型选择 matched 但概率分布缺乏依据时，曾被当作明确匹配并触发通知，且无法解释。
- 来源设计：`.trellis/tasks/10-17-match-confirmation/design.md`（R1 门控 + R2 追溯）。
  品牌证据约束（R3）与历史重算治理（R4）不在本期。

### 2. Signatures

```ts
// src/lib/db/migrations.ts —— 追加版本 4，不改 V1/V2/V3，不改唯一键
const V4_MATCH_CONFIRMATION_TRACE: string;
// ALTER TABLE evaluations ADD COLUMN model_result / decision_reason /
//   decision_policy_version / decision_policy_json / jev_request_id  TEXT（全部可空）

// src/lib/jev/match-policy.ts —— 纯函数，不读 env/DB/时间
export const MATCH_CONFIRMATION_POLICY_VERSION = "match-confirmation-v1";
export const MATCH_CONFIRMATION_POLICY: MatchConfirmationPolicy; // { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 }（冻结）
export function isCompleteProbabilityDistribution(p: Record<string, number> | null, tolerance: number): boolean;
export interface MatchDecision { result: EvaluationResult; modelResult: ChoiceOutcome | null; reason: DecisionReason }
export function decideMatchConfirmation(answer: ParsedAnswer, policy?: MatchConfirmationPolicy): MatchDecision;

// src/lib/db/repos/evaluations.ts —— 唯一负责策略 JSON 解码
// UpsertEvaluationInput 增加 modelResult / decisionReason / decisionPolicyVersion /
//   decisionPolicy / jevRequestId（省略即写 NULL）
```

### 3. Contracts

| 列 | 新记录语义 |
| --- | --- |
| `model_result` | 模型原始三态；`parse_failed` 时为 NULL（不伪称 failed 是模型选择） |
| `decision_reason` | 确定性原因码；新失败行也是 `parse_failed` |
| `decision_policy_version` | `match-confirmation-v1` |
| `decision_policy_json` | `{"minMatchedProbability":0.8,"probabilitySumTolerance":0.01}` |
| `jev_request_id` | 成功响应对应的实际调用账本 ID，无级联删除 |

- `result` 仍是最终**业务**结果；概率/置信度/`raw_answer` 一律不改写。
- 旧行五个字段全为 NULL → UI 显示「未记录」，**不得**回退成当前策略、不得推断原模型选择。
- upsert 冲突时五个字段一起被替换，`attempts + 1`、保留原 `created_at`；
  仓库不是逐次尝试审计，重复处理同键仍覆盖最近一次结论。
- 自动判断与需求试判必须调用同一个 `decideMatchConfirmation`，保证同输入同结论。

### 4. Validation & Error Matrix

按 `decideMatchConfirmation` 的处理顺序（先命中者生效）：

| 条件 | 最终 `result` | `decision_reason` |
| --- | --- | --- |
| 原解析结果 failed | `failed` | `parse_failed` |
| 原结果 not_matched | `not_matched` | `model_not_matched` |
| 原结果 uncertain | `uncertain` | `model_uncertain` |
| matched 且 probabilities 缺失 | `uncertain` | `probabilities_missing` |
| matched 且分布不合法（键不等、非有限、越界、\|Σ−1\|>容差） | `uncertain` | `probabilities_invalid` |
| matched 且 p_matched **严格低于**其它任一选项 | `uncertain` | `choice_probability_conflict` |
| matched 且 p_matched < 0.80（原始值，不四舍五入） | `uncertain` | `matched_probability_below_threshold` |
| matched 且分布合法、并列最高或更高、p_matched ≥ 0.80 | `matched` | `matched_confirmed` |

- 分布校验：键**恰好**为 `matched` / `not_matched` / `uncertain`，各值有限且 ∈ [0,1]，
  `|Σ−1| ≤ 0.01 + 1e-12`；不补缺项、不截断、不自动归一化。
- `confidence` 仅展示，**不参与**门槛，也不得解读为业务正确率。
- 业务降级 `error` 必须为 `null`：不重试、不增加 Key 失败计数；
  真实失败（上游/解析）保持原失败路径与 `error`。

### 5. Good / Base / Bad Cases

- Good：`matched` + p=(0.9, 0.05, 0.05) → `matched_confirmed`，通知仅含本次确认需求。
- Base：`matched` + p=(0.52, 0.15, 0.33) / c=0.28 → `uncertain` + `matched_probability_below_threshold`，
  原始选择、概率、原因、策略快照全部可追溯，无新通知。
- Bad：把概率缺失/不合法当作 matched 直接通知；把降级写进 `error` 让其看起来像失败；
  通知时重扫公告全部历史 matched 把旧项混进新 payload；回填旧行伪造「已按新策略」。

### 6. Tests Required

- `tests/jev/match-policy.test.ts` — 上表逐行 + 0.80/0.7999 边界、并列最高、总和容差含浮点误差、
  confidence 缺失/越界不影响决策；样本只验证算法分支，**不得**宣称为业务准确率校准。
- `tests/db/migrate.test.ts` — V4 列存在且可空、重复 `migrate()` 第二次不重复应用。
- `tests/db/repos.test.ts` — 五字段往返；同键重试覆盖且 `attempts` 累加、`created_at` 保留；
  旧行/坏 JSON 策略解码返回 `null`。
- `tests/worker/pipeline.test.ts` — 通知成员只含本次确认项；落库 `configVersion` 为实际请求版本；
  解析失败行 `modelResult=null` / `decisionReason=parse_failed` / `error` 非空。
- `tests/service/dry-run.test.ts` — 与自动判断同结果同快照；仍不写 `evaluations`/`notifications`/`deliveries`/`jobs`。
- `tests/worker/evaluator-lease.test.ts` — 追溯字段与账本 `requestId` 对应；owner 丢失时不写业务记录。

### 7. Wrong vs Correct

#### Wrong

```ts
// 直接信任模型选择，概率完全不参与；通知重扫历史 matched
upsertEvaluation(db, { result: answer.result, ... });
if (matchedCount > 0) {
  const all = listEvaluationsByBulletin(db, bulletin.id).filter((e) => e.result === "matched");
  createNotificationAndDeliveries(db, bulletin, all);
}
```

#### Correct

```ts
// 共享纯决策：保留原始选择，按完整分布门控；通知只含本次确认项
const decision = decideMatchConfirmation(answer, policySnapshot);
upsertEvaluation(db, {
  result: decision.result,
  modelResult: decision.modelResult,
  decisionReason: decision.reason,
  decisionPolicyVersion: MATCH_CONFIRMATION_POLICY_VERSION,
  decisionPolicy: policySnapshot,
  jevRequestId: outcome.requestId,
  error: decision.result === "failed" ? answer.error : null,
});
```
