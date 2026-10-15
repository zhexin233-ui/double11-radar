# Error Handling

> Three error layers, and what each one promises.

---

## 1. HTTP boundary — `HttpError`

`src/lib/http/json.ts`:

```ts
export class HttpError extends Error { code: string; status: number }
export function handleRoute<Ctx>(handler): (req, ctx) => Promise<Response>
```

Every route is wrapped by `handleRoute`. It converts `HttpError` into
`{ ok: false, error: { code, message } }` with a Chinese `message`, and logs + returns
`INTERNAL_ERROR`/500 for anything else. Handlers therefore throw instead of building responses.

### Validation errors must always be Chinese

Zod's built-in messages are English (`Invalid input: expected string, received undefined`).
Because every API message in this project is Simplified Chinese, routes must not return
`issue.message` directly. Use the shared helper, which passes through custom Chinese messages
and otherwise falls back to a field-scoped Chinese hint:

```ts
// src/lib/http/json.ts
export function invalidBodyError(error: z.ZodError): HttpError;

// src/app/api/needs/route.ts
const body = CreateSchema.safeParse(await req.json().catch(() => null));
if (!body.success) throw invalidBodyError(body.error);
```

Customize the schema anyway so the message names the field in the user's language:

```ts
name: z.string({ error: "请填写需求名称" }).trim().min(1, "需求名称不能为空")
```

Required tests: `tests/http/json.test.ts` — a missing-field case must return the Chinese custom
message, and a schema without custom messages must still return a Chinese fallback.

---

## 2. External adapters — typed errors with retry classification

| Adapter | Error | Retry signal |
| --- | --- | --- |
| 线报酷 | `XianbaoError { status, code, retryAfterMs }` | `429` → `retryAfterMs`; `5xx`/network → retry |
| Jev | `JevError { status, retryable }` | `retryable = 5xx/429/network`; invalid JSON → `false` |
| Bark | `SendResult.retryable` | non-2xx 5xx and non-JSON body → `true`; `code !== 200` → `false` |
| 飞书 | `SendResult.retryable` | `19021/19022/19024` → `false` (config); `11232`/5xx → `true` |

Adapters must not throw raw `TypeError` from `fetch`; they catch, wrap, and classify.

### Jev 适配器与统一请求服务的边界

`src/lib/jev/client.ts` 只做传输与响应边界，**不做** Key 选择、失败计数或账本：

- 成功时返回归一化的 `usage`（`input_tokens`/`output_tokens`，缺失即 `null`）、响应 `model`
  与 `x-typesafe-request-id`（`SystemOneResponse`）；
- 失败时把可核实的用量/模型/request id 挂在 `JevError` 上（`usage`/`responseModel`/
  `upstreamRequestId`）；非 2xx 只从符合 usage 契约的字段读取，其他正文不能冒充用量；
- 结构不合法（缺 `answers`、非 JSON）仍是可分类错误（`retryable = false`），且保留已报告用量，
  避免漏记已发生的输入费用。

统一请求服务 `src/lib/service/jev-requests.ts` 负责容量、Key 选择、失败计数与账本，并在
**没有发出上游请求**时抛 `JevCallBlockedError extends JevError`：

```ts
export type JevBlockReason =
  | "not_configured" | "no_key" | "busy" | "cooldown"
  | "key_disabled" | "key_unreadable" | "key_missing";

export class JevCallBlockedError extends JevError {
  readonly reason: JevBlockReason;
  /** 配置类问题：恢复后应自动继续 */
  get isConfigProblem(): boolean;
}
```

阻塞（容量满、共享退避、无可用 Key、指定 Key 已禁用/不可解密/不存在）**不计失败、不计费**；
worker 用 `requeueJob` 延后重排，配置类问题用 `failJob(..., { permanentRetry: true })`。

**Adapter messages are Chinese and actionable; raw exception text goes to server logs only.**
Network failures from `fetch` surface as English (`fetch failed`, `The operation was aborted.`),
which is unreadable for the operator and can leak environment detail. All four adapters
(Jev / 线报酷 / Bark / 飞书) share one mapping helper, and log the original exception:

```ts
// src/lib/http/network-error.ts —— 单一实现，四个适配器共用
export function describeNetworkFailure(
  error: unknown,
  descriptor: { service: string; timeoutMs: number; target?: string | null; timeoutHint?: string; unreachableHint?: string },
): string;

// 输出形状（超时 / 连不上）
// "Jev 服务调用超时（20000 毫秒）：请检查服务地址与网络，或在页面调大超时时间"
// "Jev 服务无法连接（https://api.typesafe.ai）：请检查服务地址、NAS 出网与代理设置"
// "线报酷接口无法连接：请检查 NAS 出网与 DNS/代理设置"
// "Bark 服务无法连接（https://api.day.app）：请检查服务地址、NAS 出网与设备 Key 是否正确"

// call site（以 Bark 为例）
} catch (error) {
  console.error("[bark] 投递失败：", error);           // 原始异常只进日志
  return failure(describeNetworkFailure(error, { service: "Bark 服务", target: config.serverUrl, timeoutMs: NOTIFY_TIMEOUT_MS }));
}
```

> **Warning**: `target` 只能传非敏感地址。飞书 Webhook URL 本身是凭据，
> 因此飞书适配器**不传 target**——否则它会出现在投递记录的 `error` 字段和网页上。

Required tests: `tests/jev/client.test.ts`、`tests/sources/client.test.ts`、`tests/notify/bark.test.ts`
与 `tests/notify/feishu.test.ts` 断言消息为中文、不含 `fetch failed`，
且飞书用例额外断言消息中不含 Webhook 地址。

## 3. Worker — swallow per unit, record status, never exit

Each loop iteration is wrapped (`withGuard` in `src/worker/main.ts`) and per-channel errors are
caught inside the collector. A failed unit:

- records `runtime.lastError` / `lastErrorStage` (visible on the status page),
- keeps a typed error message in the job/delivery row,
- retries with exponential backoff until `max_attempts`, then goes `dead`.

## Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Request body fails zod | `400 INVALID_BODY`, first issue message |
| No/invalid session | `401 UNAUTHORIZED`, Chinese message |
| Missing `x-requested-with: fetch` | `403 CSRF_HEADER_MISSING` |
| `Origin` != `Host` | `403 CSRF_ORIGIN_MISMATCH` |
| Login while locked | `429 LOGIN_LOCKED` |
| Wrong password | `401 INVALID_CREDENTIALS` (after 5 failures → 5 min lock) |
| Unknown id | `404 NOT_FOUND` |
| Retry of a succeeded delivery | `409 ALREADY_SUCCEEDED` |
| Jev answered with an unknown choice | `Evaluation.result = "failed"` — **never** `matched` |
| Jev 未配置 / 池中无可用 Key（**未发出上游请求**） | `JevCallBlockedError.isConfigProblem` → job 保持 `pending` 并 `permanentRetry`，用户修好配置后自动继续；不计为线报失败 |
| 某个 Key 实际返回 401/403（`JevError.code = "auth"`） | 账本记一条 `failed` 并计入该 Key 连续失败；job 按**普通退避**重试（下次可选其它 Key），连续 3 次后该 Key 自动禁用，池中再无可用 Key 时转入上一行 |
| Jev returns an unparseable structure | job retries up to `max_attempts`, then `dead` and visible in 运行状态 |
| Jev 全池不可用 / 容量满 / 共享退避中 | 任务保持 `pending`，`last_error` 为中文说明；**绝不**当作「没有匹配」 |
| `POST /api/settings/jev/test` 未配置 | `400 JE_NOT_CONFIGURED`（中文） |
| `POST /api/settings/jev/test` 其它阻塞（容量/退避/指定 Key 禁用） | `409 JE_UNAVAILABLE`（中文），未发出请求、不计费 |
| `GET /api/bulletins` 非法 `status` | `400 INVALID_BODY`（中文，列出 `pending/matched/uncertain/failed/not_matched`） |

## Don't: turn a failure into "no match"

```ts
// Wrong: a model outage silently becomes "no match" in the UI
const matched = response.answers?.[id]?.choice === "matched";
upsertEvaluation(db, { result: matched ? "matched" : "not_matched", ... });
```

```ts
// Correct: invalid/absent answers are failures with a reason
const answer = parseAnswer(raw);           // -> { result: "failed", error }
upsertEvaluation(db, { result: answer.result, error: answer.error, ... });
```

## Required tests

- `tests/http/json.test.ts` — CSRF header/origin matrix and the `{ ok }` envelope.
- `tests/jev/prompt.test.ts` — unknown choice / missing answer / wrong type / bad probabilities.
- `tests/worker/pipeline.test.ts` — a missing Jev key leaves the job retryable and creates no
  evaluation, notification or delivery.

---

## Scenario: 外部额度耗尽与限流退避（code-spec）

### 1. Scope / Trigger

外部 API 有按出口 IP 计的请求额度（线报酷：60 次/分钟/IP/接口）。额度耗尽会让整条采集链路
在窗口内持续失败，因此额度处理必须是可测量的，而不是"失败就重试"。

### 2. Signatures

```ts
// src/lib/sources/xianbao/client.ts
export interface RateLimitInfo { limit: number | null; remaining: number | null; resetAt: string | null }
export interface FeedResult { items: NormalizedBulletin[]; cacheTtlSeconds: number | null; rateLimit: RateLimitInfo | null }

// src/lib/worker/collector.ts
export const REQUEST_BUDGET_PER_MINUTE: number;      // 30（额度的一半，留给重试）
export const MIN_REQUEST_SPACING_MS: number;         // 1200
export const RATE_LIMIT_LOW_WATERMARK: number;       // 5
export function computePollIntervalSeconds(count: number, cacheTtlSeconds: number | null): number;
export function computeRateLimitBackoff(input: { remaining: number | null; resetAt: string | null; now: Date }): string | null;
export function isRateLimitPaused(backoffUntil: string | null, now: Date): boolean;
```

### 3. Contracts

- 响应头：`x-ratelimit-limit`、`x-ratelimit-remaining`、`x-ratelimit-reset`（Unix 秒）、`retry-after`。
- 每频道轮询间隔 = `max(cache_ttl, 10, ceil(60 × 选中频道数 / REQUEST_BUDGET_PER_MINUTE))` 秒。
- 失败后 `next_poll_at` = now + `max(Retry-After, 稳态间隔)`；错误重试不得快于稳态间隔。
- `settings('runtime')` 记录 `rateLimitRemaining` / `rateLimitResetAt` / `rateLimitBackoffUntil`。
- `remaining <= RATE_LIMIT_LOW_WATERMARK` → 暂停到 `resetAt`（缺失则 now + 60s）。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `remaining > 5` | 正常调度，不暂停 |
| `remaining <= 5` 且有未来 `resetAt` | 全局暂停到 `resetAt` |
| `remaining <= 5` 且无 `resetAt` | 保守暂停 60 秒 |
| 无 `x-ratelimit-*` 头 | 不改变调度（视为未知额度） |
| 429 | 该频道记错并按 `Retry-After` 退避，其它频道继续 |

### 5. Good / Base / Bad Cases

- Good：稳态消耗约 30 次/分钟，剩余额度在 30–50 之间波动，长时间无 429。
- Base：稳态期间出现零星 429，该频道按 `Retry-After` 退避并在下一窗口恢复。
- Bad：稳态目标取满 60 次/分钟，且失败立即重试——重试流量叠加后必然在窗口内触顶。

### 6. Tests Required

- `tests/worker/collector-utils.test.ts`：额度充足不暂停；额度耗尽暂停到 `resetAt`；
  缺少 `resetAt` 时 60 秒保守暂停；无头不暂停；`count × 60 / interval <= REQUEST_BUDGET_PER_MINUTE`。
- `tests/sources/client.test.ts`：429 解析 `Retry-After`。

### 7. Wrong vs Correct

#### Wrong

```ts
// 失败立即重试，且稳态就按满额度调度 —— 重试流量叠加后必然触发 429
markChannelError(db, id, { error, lastErrorAt: nowIso, nextPollAt: nowIso });
```

#### Correct

```ts
// 重试不早于稳态间隔
const retryDelayMs = Math.max(errorRetryDelayMs(error), intervalSeconds * 1000);
markChannelError(db, id, { error, lastErrorAt: nowIso, nextPollAt: new Date(now.getTime() + retryDelayMs).toISOString() });
```
