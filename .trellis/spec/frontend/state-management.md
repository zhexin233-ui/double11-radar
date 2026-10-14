# State Management

> There is no state library. Choose the right kind of state instead.

---

## Two kinds of state

| Kind | Owner | Example |
| --- | --- | --- |
| **Server data** | `useApiResource` | channel list, status snapshot, config views |
| **Form input** | `useState` inside a keyed form component | Bark device key field, new-need name |

Server data is never copied into long-lived React state. When a mutation succeeds the page calls
`reload()` (or remounts the form via `key`), so the server remains the single source of truth.

## Decision table

| Situation | Do |
| --- | --- |
| Need a list/detail snapshot | `useApiResource` |
| Need periodic refresh | `useApiResource(path, { refreshMs })` |
| Need editable config | keyed child form with `useState(initial)` |
| Need inline row editing | uncontrolled input + `onBlur` commit |
| Need a "saved" banner | local `useState<boolean>` set from the `onSaved` callback |

## Anti-patterns

```tsx
// Wrong: mirroring server data into state via an effect
const [channels, setChannels] = useState([]);
useEffect(() => { setChannels(data.channels); }, [data]);   // lint error + stale risk
```

```tsx
// Correct: derive during render
const channels = data?.channels ?? [];
```

```tsx
// Wrong: optimistic local edit that is never confirmed by the server
setNeeds((list) => list.map((n) => (n.id === id ? { ...n, enabled: !n.enabled } : n)));
```

```tsx
// Correct: mutate, then reload
await apiSend(`/api/needs/${id}`, "PATCH", { enabled: !need.enabled });
await reload();
```
