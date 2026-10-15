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

## Example: route catch logging

```ts
// src/lib/http/json.ts
try {
  return await handler(req, ctx);
} catch (error) {
  if (error instanceof HttpError) {
    return fail(error.code, error.message, error.status);
  }
  console.error("[api] 未处理异常:", error);
  return fail("INTERNAL_ERROR", "服务器内部错误", 500);
}
```

## Never log

- Credentials or any value that can be reversed into one: Jev API key, Bark device key,
  Feishu webhook/signing secret, admin password, session token.
- Full upstream request/response bodies when they may carry credentials. Persist
  `response`/`error` truncated to 500 characters and pass them through the sanitized
  `SendResult`/`JevTestResult` shapes.
- `loadEnv()`, whose errors already name the variable but never its value.

## 调用账本与费用统计

`jev_requests` 账本与 `/api/settings/jev/usage` 投影同样面向管理员，遵循相同的敏感边界：

- **不写**明文密钥、`Authorization` 头或任何可还原的凭据；账本只存非敏感
  `key_id`/`key_label`/`key_generation` 快照（Key 删除后历史仍保留）。
- `error_message` 必须是清洗后的中文说明，**不得包含可还原的凭据**；允许包含服务地址
  （非敏感）。失败分类放 `error_code`/`http_status`。
- 用量与费用（`input_tokens`/`estimated_usd_nanos` 等）是账本字段，不是日志；费用为
  公布费率估算，不得在日志或页面表述为服务商实付账单。

## Leveling

- `console.error` — operator action required (config error, dead job, migration failure).
- `console.log` — process lifecycle only (started, shutting down, health).
- No `console.log` inside request handlers; the JSON response is the output.

> **Warning**: `Settings('runtime').lastError` is rendered on the admin status page.
> It is a user-facing field, so write Chinese, actionable text — not stack traces.
