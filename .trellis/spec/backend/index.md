# Backend Development Guidelines

> Concrete conventions for this project's server side (Next.js route handlers + worker).

---

## Overview

The backend is one pnpm package: Next.js App Router route handlers (`src/app/api/**`), a set of
server-only libraries under `src/lib/**`, and an independent worker process entry
(`src/worker/main.ts`). SQLite (better-sqlite3, synchronous) is the only store.

The approved design lives in `.trellis/tasks/10-13-xianbao-needs-matching/`:
`prd.md` (requirements + acceptance criteria), `design.md` (technical design) and
`research/impl-architecture.md` (engineering contract: versions, DDL, module boundaries).

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Database Guidelines](./database-guidelines.md) | Schema, migrations, transactions, leases | Filled |
| [Error Handling](./error-handling.md) | HttpError, typed adapter errors, retry classification | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Where logs go and what must never be logged | Filled |

---

## Non-negotiable rules

1. `src/lib/**` is server-only. Client components must never import `@/lib/db`, `@/lib/env`,
   `@/lib/auth`, `@/lib/crypto`, `@/lib/worker`. They talk to the server through `/api/*`.
2. Only `src/lib/env.ts` reads application config from the environment. The single exception is
   `src/instrumentation.ts` reading framework-provided `NEXT_RUNTIME`.
3. Every `/api/*` route except `/api/health` and `/api/auth/*` calls `requireAuth(req)`.
   Every mutating route additionally calls `requireSameOrigin(req)`.
4. Credentials never leave the server in plaintext. Config reads return
   `{ configured, masked, unreadable }` only.
5. Deterministic side effects (baseline rows, notification creation, job claiming) happen inside
   SQLite transactions, never across two separate writes.
