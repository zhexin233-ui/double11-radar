# Component Guidelines

> Composition patterns that this project relies on.

---

## Pattern: keyed form component initialized from server data

**Problem**: a config form must start from server values, but mirroring props into state with an
effect triggers `react-hooks/set-state-in-effect` (Next 16 React Compiler rule) and cascading
renders.

**Solution**: render the form as a child component whose React `key` is the server version. A key
change remounts it, so `useState(initial)` is enough.

```tsx
// jev/page.tsx
<JevForm
  key={data.version}          // remount on every save -> fresh initial state
  view={data}
  onSaved={() => { void reload(); }}
  onError={setActionError}
/>
```

```tsx
// inside JevForm
const [baseUrl, setBaseUrl] = useState(props.view.config.baseUrl);
```

**Why**: no effect, no derived-state drift, and the form can never show a stale value after save.

## Pattern: uncontrolled inputs committed on blur

For inline editing (needs list) keep no local mirror at all:

```tsx
<input
  key={`${need.id}:${need.version}:name`}
  defaultValue={need.name}
  onBlur={(event) => {
    const next = event.target.value.trim();
    if (next && next !== need.name) void save({ name: next });
    else if (!next) event.target.value = need.name;   // revert empty
  }}
/>
```

## Status badges

Always render status through the label maps so wording stays consistent:

```tsx
<span className={`badge ${detail.status}`}>{STATUS_LABELS[detail.status]}</span>
```

`api-types.ts` exports `STATUS_LABELS`, `EVALUATION_LABELS`, `DELIVERY_LABELS`.

## Money and null

```tsx
{bulletin.price === null ? "无（来源未提供，显示为空而不是 0 元）" : `${bulletin.price} 元（来源标注，不代表券后实付）`}
```

Never render `0 元` for a missing price, and never label a price as a good deal — historical low
price analysis is out of scope for this release.

## Don't

```tsx
// Wrong: silently treats a model failure as a successful "no match"
{item.status === "matched" ? "命中" : "没有匹配"}
```

```tsx
// Correct
<span className={`badge ${item.status}`}>{STATUS_LABELS[item.status]}</span>
```
