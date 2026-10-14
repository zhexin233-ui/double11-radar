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

## 2. External adapters — typed errors with retry classification

| Adapter | Error | Retry signal |
| --- | --- | --- |
| 线报酷 | `XianbaoError { status, code, retryAfterMs }` | `429` → `retryAfterMs`; `5xx`/network → retry |
| Jev | `JevError { status, retryable }` | `retryable = 5xx/429/network`; invalid JSON → `false` |
| Bark | `SendResult.retryable` | non-2xx 5xx and non-JSON body → `true`; `code !== 200` → `false` |
| 飞书 | `SendResult.retryable` | `19021/19022/19024` → `false` (config); `11232`/5xx → `true` |

Adapters must not throw raw `TypeError` from `fetch`; they catch, wrap, and classify.

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
| Jev has no API key / key is rejected (401/403) | job stays `pending` with 300s backoff (`permanentRetry`), so it recovers after the user fixes the config |
| Jev returns an unparseable structure | job retries up to `max_attempts`, then `dead` and visible in 运行状态 |

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
