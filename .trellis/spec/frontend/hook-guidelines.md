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

- Fetches through `api-client` (session cookie + `x-requested-with: fetch`).
- `refreshMs` starts a polling interval; always cleared on unmount.
- This is the **only** place allowed to `setState` inside an effect body. It carries a scoped
  `eslint-disable-next-line react-hooks/set-state-in-effect` with a written justification.

```tsx
const { data, error, loading, reload } = useApiResource<StatusDto>("/api/status", {
  refreshMs: 15000,
});
```

## Rules

1. Do not re-implement fetch-in-effect in a page. Add an option to this hook instead.
2. Do not use the hook for mutations; call `apiSend` from an event handler and then `reload()`.
3. A `path` change refetches automatically because `reload` is a `useCallback([path])`.
4. Never let the hook swallow a 401 silently — `api-client` redirects to `/login` on 401 and
   throws, so the page can still show an error.

> **Warning**: adding a second `useApiResource`-like hook will re-introduce the lint failure
> across every page and duplicate the polling/error policy.
