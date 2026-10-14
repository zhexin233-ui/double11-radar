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
