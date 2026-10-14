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
- **Field names are a cross-module contract.** Changing a column means updating
  `research/impl-architecture.md` section 4 and every repo that reads it.

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

## Required tests

- `tests/db/repos.test.ts` — insert-if-absent is idempotent; lease expiry returns a job to
  `pending`; `max_attempts` produces `dead`; a succeeded delivery is not re-claimed.
- `tests/db/migrate.test.ts` — running `migrate()` twice applies nothing the second time.
- `tests/service/config.test.ts` — secrets survive reopening the database with the same key.
