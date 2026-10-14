# Directory Structure

> How backend code is organized in this project.

---

## Directory Layout

```
src/
├── app/api/**/route.ts        # HTTP boundary only: validate, call service/repo, shape JSON
├── instrumentation.ts         # runs migrate() once at web startup (nodejs runtime)
├── lib/
│   ├── env.ts                 # loadEnv(): the ONLY application env reader
│   ├── http/
│   │   ├── json.ts            # ok/fail/HttpError/requireSameOrigin/handleRoute
│   │   └── server.ts          # getDatabase/getEnv/requireAuth/getClientIp
│   ├── auth/                  # password (scrypt), session (cookie + db), guard (rate limit)
│   ├── crypto/secrets.ts      # AES-256-GCM <-> "iv:tag:ciphertext"
│   ├── db/
│   │   ├── client.ts          # getDb() singleton, WAL + busy_timeout
│   │   ├── migrations.ts      # ordered DDL (field names are cross-module contract)
│   │   ├── migrate.ts         # idempotent BEGIN IMMEDIATE migration runner
│   │   └── repos/*.ts         # one table per file; raw SQL, no ORM
│   ├── domain/                # shared types + constants (RULE_VERSION, SESSION_COOKIE)
│   ├── sources/xianbao/       # external source adapter (client + normalize + zod schemas)
│   ├── jev/                   # TypeSafe System One adapter (client + prompt/parse)
│   ├── notify/                # bark / feishu / feishu-sign / dispatch orchestration
│   ├── service/               # config + bulletin projections used by API and worker
│   └── worker/                # collector / evaluator / deliverer / runtime-state
└── worker/main.ts             # worker process entry (startWorker + signals)
```

---

## Module Organization

- **`app/api` = boundary only.** Validate input with zod, call a repo/service function, return
  `ok(...)`. No business branching beyond mapping errors to `HttpError`.
- **`db/repos` = SQL owner.** One file per table, exported functions named for the operation
  (`insertBulletinIfAbsent`, `claimJob`, `markDeliveryResult`). Repos never call the network.
- **`sources` / `jev` / `notify` = external adapters.** Each owns its own zod schemas, its own
  typed error, and injectable `fetchImpl` for tests. Nothing above them parses raw payloads.
- **`service` = use-case composition** shared by routes and worker (`getJevRuntimeConfig`,
  `createNotificationAndDeliveries`, `describeBulletin`).
- **`worker` = scheduling + orchestration**, one file per loop.

## Naming Conventions

| Kind | Convention | Example |
| --- | --- | --- |
| Repo function | verb + entity | `markChannelSuccess` |
| Adapter function | `fetch*` / `send*` / `call*` | `fetchFeed`, `sendBark`, `callSystemOne` |
| Typed error | `<Adapter>Error` | `XianbaoError`, `JevError` |
| DB column | snake_case | `source_ns`, `last_error_at` |
| TS field | camelCase | `sourceNs`, `lastErrorAt` |
| Setting namespace | lowercase, dot for secret scope | `jev`, `notify`, `bark.deviceKey` |

---

## Examples

- External-boundary decoding: `src/lib/sources/xianbao/client.ts` + `normalize.ts`
- Transactional idempotency: `src/lib/db/repos/jobs.ts` (`enqueueJob`, `claimJob`)
- Three-state secret writes: `src/lib/service/config.ts` (`applySecretInput`)
