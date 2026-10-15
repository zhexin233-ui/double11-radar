# Hook Guidelines

> The project has exactly one custom hook. Keep it that way.

---

## `useApiResource<T>`

```ts
// src/components/use-api.ts
export function useApiResource<T>(
  path: string,
  options?: { refreshMs?: number },
): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> };
```

- Fetches through `api-client`. `apiGet(path, { signal })` sends `credentials: same-origin` +
  `x-requested-with: fetch`, defaults to `cache: "no-store"` and accepts an `AbortSignal`
  (`src/components/api-client.ts`).
- **`refreshMs` 未设置 = 关闭轮询**；设置后每 `refreshMs` 触发一次 `refresh()`，定时器在卸载时清除。
- 竞态语义集中在 `src/components/api-resource.ts` 的 `ApiResourceController`（**不导入 React**，
  可离线单测）；`useApiResource` 只把控制器接到 React 状态，仍是唯一允许在 effect 内触发加载
  的地方。

### `ApiResourceController` 契约（`src/components/api-resource.ts`）

```ts
export class ApiResourceController<T> {
  load(): Promise<void>;    // 首次加载 / path 变更：清空旧数据，中止在途，立即发新请求
  refresh(): Promise<void>; // 定时 tick：同查询在途时直接跳过（不排队、不叠加）
  reload(): Promise<void>;  // 手动/写入后刷新：保证调用之后至少发起一次新请求
  dispose(): void;          // 卸载：中止在途、停止提交、释放等待者
}
```

- `load()` 先 `data: null`（新查询绝不展示旧结果）再发起请求；同查询刷新失败只写 `error`，
  保留既有列表。
- `reload()` 在无在途时直接 `start()`；有在途时把 generation +1（作废旧响应）并排一次尾随
  刷新，等它完成后 resolve，绝不只合并到保存前的旧 GET。
- 每次请求带自己的 `generation` 与 `AbortSignal`；只有 `!disposed && !signal.aborted &&
  generation === 当前值` 才提交，旧 generation 绝不 `setState`。
- `dispose()` 在 path 变更或卸载时中止在途请求并让等待中的 reload 结束，避免离开页面后泄漏。
- `refresh()` 是「慢请求不叠加」的唯一实现：在途时本次 tick 直接丢弃，不积压。

```tsx
// 记录页：默认关闭，由用户开关控制，开启时每 5 秒刷新（BULLETIN_AUTO_REFRESH_MS）
const { data, error, loading, reload } = useApiResource<BulletinsResponse>(path, {
  ...(autoRefresh ? { refreshMs: BULLETIN_AUTO_REFRESH_MS } : {}),
});
```

## Rules

1. Do not re-implement fetch-in-effect in a page. Add an option to this hook instead.
2. Do not use the hook for mutations; call `apiSend` from an event handler and then `reload()`.
3. A `path` change rebuilds the controller (`useMemo([path])`) and `load()`s the new query; old
   in-flight requests are aborted and their generation cannot commit.
4. Never let the hook swallow a 401 silently — `api-client` redirects to `/login` on 401 and
   throws, so the page can still show an error.

> **Warning**: adding a second `useApiResource`-like hook will re-introduce the lint failure
> across every page and duplicate the polling/error policy.
