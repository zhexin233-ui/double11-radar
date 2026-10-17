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

Every admin page composes the same primitives from `src/components/ui/`. They are
presentational only — a page keeps the data hook, mutations, and business state.

```tsx
<div className="page">
  <PageHeader title="线报记录" lead="…" actions={<Button variant="default">刷新</Button>} />
  <Section title="现有记录">
    <List>{/* <ListItem> */}</List>
    <Pagination page={safePage} total={total} pageSize={PAGE_SIZE} onPage={setPage} unit="条" />
  </Section>
  {error ? <Feedback kind="error">加载失败：{error}</Feedback> : null}
</div>
```

| Primitive | Props | Notes |
| --- | --- | --- |
| `PageHeader` | `title`, `lead?`, `actions?`, `children?` | Renders the single `h1` for the page |
| `Section` | `title?`, `description?`, `actions?`, `headingLevel?`, `id?`, `alt?`, `className?`, `children` | 默认 = 顶部规则线；`alt` = 浅底强调面板；`id` 用于页内锚点 |
| `List` / `ListItem` | `children`, `className?` | 渲染 `<ul class="list">` / `<li class="list-item">`，只给结构与类名 |
| `Eyebrow` | `items: ReactNode[]` | 小标签行，分隔点由 CSS 的 `.sep::before` 生成（`aria-hidden`） |
| `Pagination` | `page`, `total`, `pageSize`, `onPage`, `unit?`, `note?` | `total === 0` 返回 `null`；`onPage` 内部用 `clampPage` 兜底 |
| `TableScroll` | `label` (required), `minTableWidth?`, `className?`, `children` | `role="region"` + `aria-label` + `tabIndex={0}` |
| `StatusBadge` | `status`, `children` | 唯一的「状态 → 颜色」映射；文案由调用方传 label |
| `Feedback` | `kind: "loading" \| "success" \| "error" \| "notice"`, `children` | `error` → `role="alert"`；其余 → polite live region |

**Convention**: a test/action result that can be either success or failure must not be
hard-coded to `kind="success"`. Track the kind next to the message (or use `notice`), so a
failure is not shown in green.

## Pattern: 编辑式条目列表（非表格数据）

行级列表（线报记录、需求清单）用 `List` / `ListItem`，**不要**用表格或自制 div 堆：

```tsx
<List>
  {items.map((item) => (
    <ListItem key={item.id}>
      <div className="list-body">
        <div>
          <Eyebrow items={[<StatusBadge status={item.status}>{STATUS_LABELS[item.status]}</StatusBadge>, item.sourceNs, time]} />
          <Link className="list-title" href={`/bulletins/${item.id}`}>{item.title}</Link>
          <div className="list-meta">…</div>
        </div>
        <div className="list-trailing"><Button variant="subtle">…</Button></div>
      </div>
    </ListItem>
  ))}
</List>
```

- 行内**只能有一个链接**（标题）；操作按钮与它平级，不嵌套进链接。
- 行内可编辑字段用 `TextInput variant="unstyled"` + `classNames={{ input: "list-title" }}`（备注用
  `list-note`）：平时读起来像文本，悬停/聚焦才出现底线，避免整行被表单框包住。焦点可见性仍由全局
  `:focus-visible` 的 outline 负责，**不要**设 `outline: none`。
- 结构化表格数据（频道勾选、逐需求判断、投递、密钥、用量）仍然用真 `<table>`，包在 `TableScroll` 里。

## Pattern: 分页与越界收敛

所有列表共用 `Pagination`；`api-types.ts` 里的 `*_PAGE_SIZE` 是唯一页大小来源。

```tsx
const [page, setPage] = useState(0);
const path = `/api/needs?limit=${NEEDS_PAGE_SIZE}&offset=${page * NEEDS_PAGE_SIZE}`;
const { data } = useApiResource<PagedItems<NeedDto>>(path);

// total 缩减（数据被清理 / 筛选变化）时收敛到最后一个有效页。
// 用「渲染期比较后修正 state」，不要用 useEffect + setState：
// react-hooks/set-state-in-effect 会报错，而且 ApiResourceController 在 path 变化时
// 会清空 data，纯派生 offset 会在 page 与 clamp 结果之间抖动成请求循环。
const total = data?.total ?? null;
if (total !== null) {
  const clamped = clampPage(page, total, NEEDS_PAGE_SIZE);
  if (clamped !== page) setPage(clamped);
}
```

- 服务端分页参数由 `src/lib/http/query.ts` 的 `parsePageQuery` 解析（见 backend spec），前端不自己 clamp。
- 前端分页 `total` 的来源：`/api/bulletins.total`、`/api/needs.total`、`/api/channels.stats.total`、
  `/api/settings/jev/usage.recent.total`。**不要把 `stats.total` 额外复制成一个 `total` 字段。**

### 变体：客户端分页（数据已全量在前端）

服务端返回完整数组、`total` 由数组长度决定时（例：`/api/settings/jev.keys`、`usage.byKey`），
**不要**照搬上面的「渲染期比较后 setState」——那套只在服务端 `total` 会独立变化时才需要。
客户端分页的 `safePage` 与 `total` 全部是纯派生，写 state 只会引入 `set-state-in-render` 风险：

```tsx
export function JevUsageByKey(props: { rows: JevUsageByKeyDto[] }) {
  const [page, setPage] = useState(0);
  const total = props.rows.length;                                  // total = 数组长度
  const safePage = clampPage(page, total, JEV_USAGE_BY_KEY_PAGE_SIZE); // 纯派生，不 setState

  return (
    <>
      <ByKeyTable rows={props.rows.slice(0, JEV_USAGE_BY_KEY_PREVIEW)} label="…（预览）" />
      <Modal opened={opened} onClose={…} size={1000}>
        <ByKeyTable rows={pageSlice(props.rows, safePage, PAGE_SIZE)} label="…（全部）" />
        <Pagination page={safePage} total={total} pageSize={PAGE_SIZE} onPage={setPage} unit="个 Key" />
      </Modal>
    </>
  );
}
```

- `pageSlice(items, page, pageSize)`（`pagination-model.ts`）是唯一的切片实现：内部先 `clampPage`，
  空集或非法页大小返回 `[]`。**不要在各组件里自己写 `items.slice(page * n, …)`。**
- 页码重置：把持有 `page` 的组件放在 `Modal` body 内部即可——`keepMounted` 默认 `false`，
  弹窗关闭即卸载，重开自动回到第 1 页，不需要 `useEffect`。
- 预览 + 弹窗共用**同一个**表格组件（只差 `rows` 与 `label`），避免两套单元格逻辑漂移。
- 客户端分页的页大小是纯展示参数，服务端没有镜像常量，不受「两边必须同步」的约束（见 `type-safety.md`）。

## Pattern: 弹窗栈（一个弹窗里再开弹窗）

需求是「列表弹窗 → 编辑弹窗 → 确认弹窗」这类多层结构时，用 `Modal.Stack` + 每个 `Modal` 的 `stackId`，
而不是并列写几个独立 `Modal`：

```tsx
<Modal.Stack>
  <Modal opened={props.opened}  onClose={closeKeys} stackId="jev-keys"     size={1200} centered … />
  <Modal opened={editingKey !== null} onClose={…}   stackId="jev-key-edit" size="lg"   centered … />
  <Modal opened={pendingConfirm !== null} onClose={…} stackId="jev-confirm"            centered … />
</Modal.Stack>
```

- 只有**同时**给了 `stackId` 且处于 `Modal.Stack` 的 context 内，Mantine 才会接管栈：
  z-index 变成 `calc(maxZIndex + 栈内下标 + 1)`，`closeOnEscape` / `trapFocus` 只对栈顶生效，
  非栈顶的 content 带 `data-hidden`（`opacity:0; pointer-events:none`），用户点不到下层。
- 三个 `Modal` 必须都在**同一个** `Modal.Stack` 里，`stackId` 必须唯一。栈顶由 `opened` 的转换顺序决定：
  先开基础弹窗、再开编辑、最后开确认，顺序才对（不要靠 JSX 书写顺序）。
- 分层弹窗里**不要**用 `useModalsStack`，当基础弹窗的 `opened` 由页面持有时（例如触发按钮在 `Section.actions`），
  `useModalsStack` 会引入第二个 state owner；`stackId` 只要求 context，不要求状态放在弹窗组件里。
- `size` 只接受内置尺寸名或**数字**（数字走 `rem(n)`，即 `size={1200}` → 1200px）。
  写 CSS 字符串（`size="min(1200px, 96vw)"`）会被拼成 `var(--modal-size-min(...))`，是无效 CSS。
  超宽弹窗在窄屏由 Mantine 自己的 `max-width: 100%` + `--modal-inner-x-offset: 5vw` 收敛到 90vw。
- 弹窗内容保持卸载（不要开 `keepMounted`）：200 行 Mantine 控件的表格只在打开时才渲染。

## Gotcha: 弹窗内的反馈会被遮罩挡住

**症状**：点「保存」后一切正常，但用户看不到任何成功 / 失败提示；或者只在关掉弹窗后才看到。

**原因**：页面顶部的 `notice` / `actionError` 反馈区在弹窗遮罩**下面**（`Modal` 默认 `withinPortal`，
遮罩覆盖全屏），弹窗打开期间那条消息等于不存在。

**修复**：反馈必须渲染在用户当前能看到的那一层。分层弹窗的写法是把同一个 `notice` 在**每个**
Modal body 里渲染一次（顶层弹窗总能看到；关闭上层后同一条消息仍在下层可见）：

```tsx
<Modal opened={props.opened} …>
  <KeysModalBody notice={notice} loadError={props.loadError} … />
</Modal>
<Modal opened={editingKey !== null} …>
  <PanelNotice notice={notice} />
  …
</Modal>
```

配套约定：

- 打开下一层弹窗前先 `setNotice(null)`，避免旧结果被读成新操作的结果。
- 破坏性操作**失败**时保持确认弹窗打开（错误就显示在它里面，可直接重试）；成功时关闭它。
- 操作结果不要同时写页面顶部与弹窗内，否则同一句话会出现两遍。

## Pattern: Mantine 的使用边界

用库：`Button` / `TextInput` / `PasswordInput` / `NumberInput` / `Textarea` / `Select` / `Switch` /
`Checkbox` / `Radio` / `Fieldset` / `Modal` / `Pagination` / `Alert` / `Loader` / `Badge`。

不用库：页面容器、区块、条目列表、`table` 元素本身、锚点导航 —— 这些决定编辑式观感，
换库会退化成普通后台外观。布局间距继续用 `.row` / `.stack` / `.toolbar` / `.grid-2`，
不混入 `Group` / `Stack` 的 spacing。

- 忙态用 `Button loading={busy}`，不要再手写「保存中…」文案切换。
- 破坏性确认用 `Modal`（可键盘操作），不要再新增 `window.confirm`。把行内操作搬进弹窗时，
  顺手把该处已有的 `window.confirm` 也换成确认弹窗——`src/app/(admin)/jev/page.tsx` 的三处已在
  2026-10 全部替换（切换列表只读 + 编辑弹窗的任务）。
- 状态颜色只由 `StatusBadge` 决定；状态文案只由 `api-types.ts` 的 label 映射决定。

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

`api-types.ts` exports `STATUS_LABELS`, `EVALUATION_LABELS`, `DELIVERY_LABELS`, and the
`deliveryLabel(status: string)` helper for the `/api/status` 聚合计数（未知状态原样返回，不伪造标签）。

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
