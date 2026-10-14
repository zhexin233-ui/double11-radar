# Quality Guidelines

> Standards enforced by `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

---

## Gates

```sh
pnpm lint        # eslint (flat config, eslint-config-next)
pnpm typecheck   # tsc --noEmit, strict
pnpm test        # vitest run
pnpm build       # next build
```

All four must pass before a task is considered implemented.

## Conventions

1. **All comments, UI copy, API messages and commit messages are Simplified Chinese.**
   Identifiers and file names stay English.
2. **One owner per contract.** Domain types live in `src/lib/domain/types.ts`; external payloads
   are decoded once, by a zod schema in the adapter that owns them. Never cast `unknown` inline in
   a consumer.
3. **Inject I/O for tests.** `fetchImpl` in `sources/xianbao`, `jev`, `notify`; `now?: () => Date`
   in worker loops. Tests must run offline and deterministically.
4. **Validate before writing.** Zod at the HTTP boundary and at every external boundary.
5. **Keep the API envelope.** `{ ok: true, data }` / `{ ok: false, error: { code, message } }`.
6. **No ORM, no UI kit, no Tailwind.** `better-sqlite3` + plain CSS were deliberate choices.

## Forbidden patterns

| Don't | Why | Instead |
| --- | --- | --- |
| Import `@/lib/db` from a `"use client"` file | Would ship DB/env code to the browser | Call `/api/*` |
| `process.env.X` outside `src/lib/env.ts` | Config would become untestable and unscannable | `loadEnv()` |
| `db.prepare(...).run({ flag: boolean })` | better-sqlite3 throws on booleans | Bind `0/1` |
| `INSERT OR REPLACE` for incoming bulletins | Deletes attached evaluations/deliveries | `INSERT OR IGNORE` |
| Returning a secret from a config read | Contract violation (AC1) | `{ configured, masked, unreadable }` |
| Treating `uncertain` or `failed` as `matched` | False notifications | Only `matched` creates a notification |
| `setState` directly in an effect body | Next 16 React Compiler rule; cascading renders | `useApiResource` / keyed form components |
| `window.location.href = "/..."` | Blocked by eslint rule | `window.location.replace()` |

## Testing conventions

- `tests/helpers/db.ts` creates a migrated temp database; `tests/setup.ts` sets env vars and the
  test encryption key (`Buffer.alloc(32, 7)`, matching `testKey()`).
- Name tests with the acceptance criterion they cover: `"基线语义（AC4）"`.
- Mock only the transport. Assertions must state that mock verification is not real-interface
  verification.
