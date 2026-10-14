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

## Convention: 验收 / 诊断端点必须复用生产链路且不可写库

**What**：任何为了验收或排查而新增的端点（例如 `POST /api/settings/jev/dry-run`）必须
复用生产使用的同一套构造与解析代码，并且不得写入业务表。

**Why**：如果验收工具自己实现一份判定逻辑，它验证的就不是生产行为；如果它会写库，
验收动作本身就会污染判断记录、通知或投递状态，让"线上结果"不可信。

**Example**：

```ts
// src/lib/service/dry-run.ts —— 复用 buildQuestions / parseAnswers / callSystemOne
const { questions, needByQuestionId } = buildQuestions(needs);
const response = await call(config, { state, model, questions });
const answers = parseAnswers(response, Object.keys(questions));
// 只返回结果；不调用 upsertEvaluation / createNotificationAndDeliveries
```

**断言要求**：验收端点的测试必须断言 `evaluations` / `notifications` / `deliveries` / `jobs`
计数在调用前后均为 0（见 `tests/service/dry-run.test.ts`）。

**相关**：`spec/backend/error-handling.md`（失败分类）、`frontend/component-guidelines.md`（面板文案）。

---

## Testing conventions

- `tests/helpers/db.ts` creates a migrated temp database; `tests/setup.ts` sets env vars and the
  test encryption key (`Buffer.alloc(32, 7)`, matching `testKey()`).
- Name tests with the acceptance criterion they cover: `"基线语义（AC4）"`.
- Mock only the transport. Assertions must state that mock verification is not real-interface
  verification.

---

## Gotcha: 必须固定包管理器版本，否则镜像构建会失败

**Symptom**：`pnpm install --frozen-lockfile` 在容器内报
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，本地 `pnpm install` 却正常。

**Cause**：`package.json` 未声明 `packageManager` 时，`corepack enable` 会安装**最新**的 pnpm
（实测拉到 12.x）。新版 pnpm 默认启用 `minimumReleaseAge` 供应链策略，会拒绝锁文件中"刚发布
几小时"的传递依赖（实测为 `caniuse-lite`）。

**Fix**：在 `package.json` 固定版本，使镜像与本地使用同一个 pnpm：

```json
{
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=22", "pnpm": ">=10.13.1 <11" }
}
```

**Prevention**：升级 pnpm 时同步更新 `packageManager` 与锁文件，并在 Docker 里重新验证
`pnpm install --frozen-lockfile`；不要用 `--no-frozen-lockfile` 或放宽策略来"绕过"该报错。

## Gotcha: 调试进程会污染出口 IP 的限流额度

**Symptom**：容器内采集持续出现 429，但代码预算明显低于官方额度。

**Cause**：额度按**出口 IP** 计。此前遗留的宿主调试进程（`tsx src/worker/main.ts`）在同一个
公网 IP 上并行轮询 20 个频道，叠加后超过 60 次/分钟。

**Prevention**：调试结束后确认子进程已退出
（`ps -eo pid,ppid,command | grep 'src/worker/main.ts'`）；不要在同一出口 IP 上同时运行两个
采集进程。`pnpm worker` 会派生子进程，只杀 `pnpm` 父进程不足以停止它。
