# Logging Guidelines

> Minimal, safe logging. This project has no log framework by design.

---

## Where to log

| Location | Allowed |
| --- | --- |
| `handleRoute` catch | `console.error("[api] 未处理异常:", error)` |
| Worker loop guard | `console.error("[worker] <loop> 异常：<message>")` |
| Decrypt failure | `console.error("[config] 凭据 <namespace> 无法解密：", error)` |
| CLI entries | `console.log` for start/shutdown/one-off results |

Live status is **not** taken from logs: it is persisted in `settings('runtime')`
(`src/lib/worker/runtime-state.ts`) and exposed by `GET /api/status`.

## Never log

- Credentials or any value that can be reversed into one: Jev API key, Bark device key,
  Feishu webhook/signing secret, admin password, session token.
- Full upstream request/response bodies when they may carry credentials. Persist
  `response`/`error` truncated to 500 characters and pass them through the sanitized
  `SendResult`/`JevTestResult` shapes.
- `loadEnv()`, whose errors already name the variable but never its value.

## Leveling

- `console.error` — operator action required (config error, dead job, migration failure).
- `console.log` — process lifecycle only (started, shutting down, health).
- No `console.log` inside request handlers; the JSON response is the output.

> **Warning**: `Settings('runtime').lastError` is rendered on the admin status page.
> It is a user-facing field, so write Chinese, actionable text — not stack traces.
