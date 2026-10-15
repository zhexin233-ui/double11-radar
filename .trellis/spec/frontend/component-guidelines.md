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

## Pattern: presentational primitives for page structure

Every admin page composes the same four primitives from `src/components/ui/`. They are
presentational only — a page keeps the data hook, mutations, and business state.

```tsx
<div className="page">
  <PageHeader title="线报记录" lead="…" actions={<button className="btn-ghost">刷新</button>} />
  <Section title="现有需求" description="…">
    <TableScroll label="需求清单" minTableWidth={860}>{/* <table/> */}</TableScroll>
  </Section>
  {error ? <Feedback kind="error">加载失败：{error}</Feedback> : null}
</div>
```

| Primitive | Props | Notes |
| --- | --- | --- |
| `PageHeader` | `title`, `lead?`, `actions?`, `children?` | Renders the single `h1` for the page |
| `Section` | `title?`, `description?`, `actions?`, `headingLevel?`, `id?`, `alt?`, `className?`, `children` | `alt` = 浅灰面板；`id` 用于页内锚点 |
| `TableScroll` | `label` (required), `minTableWidth?`, `className?`, `children` | `role="region"` + `aria-label` + `tabIndex={0}` |
| `Feedback` | `kind: "loading" \| "success" \| "error" \| "notice"`, `children` | `error` → `role="alert"`；其余 → polite live region |

**Convention**: a test/action result that can be either success or failure must not be
hard-coded to `kind="success"`. Track the kind next to the message (or use `notice`), so a
failure is not shown in green.

## Convention: wide tables scroll themselves

A `TableScroll` only clips/scrolls when its `<table>` is wider than the container. A bare
`table { width: 100% }` shrinks to the container and collapses columns to one character per
line on 窄屏. Give the table a readable minimum width:

```tsx
<TableScroll label="Jev API 密钥列表" minTableWidth={1100}>{/* table */}</TableScroll>
```

`minTableWidth` sets `--table-min` on the wrapper; `globals.css` applies
`.table-scroll table { min-width: var(--table-min, 720px); }`. Do not hide columns or render a
second mobile-only DOM.

## Gotcha: never `scrollIntoView` inside the nav

**Symptom**: pressing Tab on an admin page skips「跳至正文」and the first nav entries.

**Cause**: `element.scrollIntoView()` during mount moves Chromium's *sequential focus
navigation starting point* to that element, so the first Tab starts after it.

**Fix**: scroll the nav container itself — this never touches the document focus origin:

```tsx
const nav = navRef.current;
if (nav.scrollWidth <= nav.clientWidth) return;
const navRect = nav.getBoundingClientRect();
const activeRect = active.getBoundingClientRect();
nav.scrollTo({
  left: nav.scrollLeft + activeRect.left - navRect.left - (navRect.width - activeRect.width) / 2,
  behavior: reduceMotion ? "auto" : "smooth",
});
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
