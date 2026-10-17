# 技术设计：Jev 密钥列表与按 Key 汇总改为弹窗分页表格

上游事实与代码锚点见 `research/current-behavior.md`（行号以此为准）。需求编号沿用 `prd.md`。

## 1. 边界

### 1.1 改动文件（6 个，全部在前端）

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `src/app/(admin)/jev/page.tsx` | 改 | 删除 `JevKeyAddForm` / `JevKeyRow` / 密钥表；`#jev-keys` 改为摘要 + 按钮；`JevUsagePanel` 的「按 Key 汇总」改为预览 + 弹窗；`formatTime` 改为导入 |
| `src/components/JevKeysPanel.tsx` | 新增 | 密钥管理三弹窗（管理 / 编辑 / 确认）+ 新增表单 + 只读表格 + 弹窗内反馈 |
| `src/components/format.ts` | 新增 | `formatTime(value: string \| null): string`（当前是 6 个页面各自的局部副本，这里只统一 jev 相关文件） |
| `src/components/pagination-model.ts` | 改 | 新增纯函数 `pageSlice` |
| `src/components/api-types.ts` | 改 | 新增 `JEV_KEYS_PAGE_SIZE` / `JEV_USAGE_BY_KEY_PAGE_SIZE` / `JEV_USAGE_BY_KEY_PREVIEW` |
| `tests/components/pagination-model.test.ts` | 改 | 补 `pageSlice` 用例 |

### 1.2 明确不动

- `src/lib/**` 与 `src/app/api/**`：无服务端改动、无迁移、无 DTO 变更。
- `JevForm` / `DryRunPanel` / 「测试连接」按钮 / `#jev-connection` / `#jev-strategy` / `#jev-dry-run`。
- `globals.css`（颜色令牌、`.pagination-bar`、`.table-scroll` 等全部复用）。
- `JevUsagePanel` 的 summary `dl.facts` 与「最近调用」表 + 服务端分页（`USAGE_PAGE_SIZE = 20`）。
- `src/app/(admin)/{bulletins,needs,status,channels}` 里各自局部副本的 `formatTime`（不在本任务范围）。

## 2. 为什么是前端分页（取舍）

`/api/settings/jev` 的 `keys` 与 `/api/settings/jev/usage` 的 `byKey` 都是**一次性完整数组**，
没有 `limit` / `offset` / `total`。两条路：

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 前端分页 | 0 服务端改动；200—1000 条的 JSON 与一次 `useApiResource` 拉取本来就在发生；表格渲染从「全部」降到「10 行」，DOM 成本反而显著下降 | **采用** |
| 服务端分页 | 要给两个接口加参数、给 `byKey` 加 `total`（现在没有）、改 `api-types` 与服务端 spec；`byKey` 是个聚合结果，加 LIMIT/OFFSET 要改聚合 SQL | 不采用（本任务） |

遗留限制（写进代码注释，不藏在 PRD 里）：**整个 `keys` / `byKey` 数组仍会一次性返回给浏览器**。
若将来 Key 数进入数千级，需要另开任务做服务端分页。

## 3. 组件结构与状态归属

```
jev/page.tsx (JevPage)                         ← 数据 owner：useApiResource × 2、reloadAll
├── #jev-keys  <Section actions={<Button>管理密钥</Button>}>
│     └── 摘要 <p> / 空态 <p>
├── <JevKeysPanel keys loadError reload opened onClose />   ← 只在弹窗里有状态
│     └── <Modal.Stack>
│           ├── Modal stackId="jev-keys"     ← opened 由页面持有
│           │     └── <KeysModalBody>        ← 新增表单 + 只读表 + Pagination（page state 在体内）
│           ├── Modal stackId="jev-key-edit"
│           │     └── <KeyEditForm key={`${id}:${updatedAt}`}>
│           └── Modal stackId="jev-confirm"  ← 破坏性确认
└── JevUsagePanel（页面内联组件，保留）
      └── h3 按 Key 汇总 + <JevUsageByKey rows={usage.byKey} />   ← 预览 + 弹窗
```

状态归属（沿用 `state-management.md` 的「服务端数据只有一份」）：

| 状态 | 归属 | 理由 |
| --- | --- | --- |
| `keys` / `byKey` | 页面 `useApiResource` → props 下传 | 服务端数据不得复制进组件 state |
| `keysOpened` | 页面 `useState` | 按钮在 `Section.actions`，属于页面 |
| `editingKeyId` | `JevKeysPanel` | 纯 UI 选择，不跨区块 |
| `pendingConfirm` | `JevKeysPanel` | 同上 |
| `notice`（密钥操作反馈） | `JevKeysPanel` | R6：反馈必须渲染在弹窗内，不能写到页面顶部 |
| `busy`（破坏性操作） | `JevKeysPanel` | 确认按钮的 loading |
| `secretAction` / `secret` / `busy`（非破坏性） | `KeyEditForm` | 表单输入态 + 它自己的请求忙态 |
| `page`（密钥表） | `KeysModalBody` | 子组件随弹窗关闭而卸载 → 每次重开自动回到第 1 页 |
| `page`（按 Key 汇总） | `JevUsageByKey` | 打开弹窗时显式 `setPage(0)` |

**不使用** `useModalsStack`：基础弹窗的 `opened` 由页面持有，`useModalsStack` 会引入第二个
state owner。改用 `Modal.Stack` 提供 context + 每个 `Modal` 显式 `stackId`——`Modal` 的
`closeOnEscape` / `trapFocus` / `zIndex` 栈管理只看 `stackId` 与 context，与「谁持有 `opened`」无关
（源码事实见 research §5）。

## 4. 分页模型

### 4.1 新增纯函数（`pagination-model.ts`）

```ts
/**
 * 取客户端分页的某一页（数据已全量在前端）。
 *
 * `total` 即 `items.length`；越界 / 非法页码先经 `clampPage` 收敛，
 * 非法页大小返回空数组，空集返回空数组。
 */
export function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!Number.isFinite(pageSize) || pageSize <= 0) return [];
  const safePage = clampPage(page, items.length, pageSize);
  const start = safePage * pageSize;
  return items.slice(start, start + pageSize);
}
```

### 4.2 客户端分页统一写法

```tsx
const [page, setPage] = useState(0);
const total = rows.length;                                       // 客户端 total = 数组长度
const safePage = clampPage(page, total, PAGE_SIZE);              // 纯派生，不写 state
<Pagination page={safePage} total={total} pageSize={PAGE_SIZE} onPage={setPage} unit="个 Key" />
{pageSlice(rows, safePage, PAGE_SIZE)}                           // 渲染
```

**不**使用页面级的「渲染期比较后 setState」模式（那是服务端分页 `total` 变化时的收敛手段，
见 `component-guidelines.md`）：这里的 `total` 完全由 props 派生，`safePage` 也是纯派生，
没有 state 抖动，也就不会触发 `react-hooks/set-state-in-render`。

### 4.3 常量（`api-types.ts`，紧随 `CHANNELS_PAGE_SIZE`）

```ts
/** 密钥管理弹窗每页条数（客户端分页：`/api/settings/jev.keys` 一次性返回完整数组）。 */
export const JEV_KEYS_PAGE_SIZE = 10;

/** 按 Key 汇总弹窗每页条数（客户端分页：usage.byKey 一次性返回完整数组）。 */
export const JEV_USAGE_BY_KEY_PAGE_SIZE = 10;

/** 「按 Key 汇总」在页面上保留的预览行数（沿用服务端排序：已知费用降序）。 */
export const JEV_USAGE_BY_KEY_PREVIEW = 5;
```

这三个是**客户端展示参数**，服务端没有对应常量（`keys` / `byKey` 无分页参数），
所以 `type-safety.md` 里「镜像常量两边必须同步」的警告不适用于它们。

## 5. 密钥区（R1 / R2 / R3 / R4 / R6）

### 5.1 `#jev-keys` 页面部分

```tsx
const enabledKeys = data.keys.filter((key) => key.enabled).length;

<Section
  id="jev-keys"
  className="anchor-target"
  title="API 密钥"
  description={/* 原文案不变 */}
  actions={
    <Button variant="default" size="sm" onClick={() => setKeysOpened(true)}>
      管理密钥
    </Button>
  }
>
  {data.keys.length === 0 ? (
    <p className="muted" style={{ margin: 0 }}>
      还没有配置 Jev 密钥。添加后，后台判断、连接测试与需求试判都会从密钥池调度。
    </p>
  ) : (
    <p className="muted" style={{ margin: 0 }}>
      共 {data.keys.length} 个 Key · {enabledKeys} 个启用。密钥较多时不再把长表铺在页面上，
      改为在弹窗内分页查看与编辑。
    </p>
  )}
</Section>
<JevKeysPanel
  opened={keysOpened}
  onClose={closeKeys}
  keys={data.keys}
  loadError={settings.error}
  reload={reloadAll}
/>
```

`closeKeys()` 同时 `setKeysOpened(false)` 并清空 `notice`（在 panel 内通过 `onClose` 统一处理）。

### 5.2 `JevKeysPanel` 职责

**容器**（持有 `notice` / `editingKeyId` / `pendingConfirm` / `confirmBusy`）：

| 函数 | 触发者 | 行为 |
| --- | --- | --- |
| `guard(action)` | 破坏性操作复用 | `confirmBusy=true` → 执行 → 成功写 `notice{success}` → `await reload()`；失败写 `notice{error}` 并**保持确认弹窗打开**以便重试；`finally` 复位 busy |
| `requestConfirm(kind)` | 编辑弹窗的清除 / 停用 / 删除 | `setNotice(null)` + `setPendingConfirm({ kind, key })` |
| `confirmPending()` | 确认弹窗「确认」 | 按 `kind` 发请求（见 5.4），成功时关确认弹窗；`delete` 额外关编辑弹窗 |
| `finishEdit(message)` | 编辑弹窗的成功回调（重命名 / 替换 / 测试） | `setNotice({kind:"success",text:message})` → `await reload()` |
| `failEdit(message)` | 编辑弹窗的失败回调 | `setNotice({kind:"error",text:message})` |

**`editingKey` 派生，不存快照**：

```tsx
const editingKey = props.keys.find((key) => key.id === editingKeyId) ?? null;
```

→ `reload()` 后编辑弹窗立刻显示最新值（R3）；Key 被删除后 `editingKey` 变 `null`，
弹窗 `opened={editingKey !== null}` 自动关闭。

### 5.3 三个 Modal

```tsx
<Modal.Stack>
  {/* 管理：opened 由页面持有 */}
  <Modal opened={props.opened} onClose={props.onClose} stackId="jev-keys"
         title="Jev API 密钥" size={1200} centered>
    <KeysModalBody ... />
  </Modal>

  <Modal opened={editingKey !== null} onClose={() => setEditingKeyId(null)} stackId="jev-key-edit"
         title={editingKey ? `编辑密钥：${editingKey.label}` : "编辑密钥"} size="lg" centered>
    <KeyEditForm key={`${editingKey.id}:${editingKey.updatedAt}`} item={editingKey} … />
  </Modal>

  <Modal opened={pendingConfirm !== null} onClose={() => setPendingConfirm(null)} stackId="jev-confirm"
         title="确认操作" centered>
    …
  </Modal>
</Modal.Stack>
```

- `size={1200}`（**数字**，`getSize` 转 `rem(1200)`＝1200px）配合 `TableScroll minTableWidth={1100}`；
  窄屏由 Mantine 的 `max-width: 100%` + `--modal-inner-x-offset: 5vw` 收敛到 90vw，表内继续横向滚动。
  **不要**写 `size="min(1200px, 96vw)"`：字符串会被拼成 `var(--modal-size-min(...))`，是无效 CSS（research §5）。
- `Modal.Stack` 必须包住这三个 `Modal`，否则 `stackId` 拿不到 context，z-index / Escape / focus trap 全失效。
- `keepMounted` 默认 `false` → 关闭即卸载内容，`KeysModalBody` 的 `page` 随之重置。

### 5.4 破坏性操作（R4）

| kind | 请求 | 确认文案（原样保留） | 成功后 notice |
| --- | --- | --- | --- |
| `clear` | `PATCH { apiKey: { clear: true } }` | 清除「{label}」的密钥？清除后会停用该 Key，需要替换密钥后才能再次启用。 | 已清除「{label}」的密钥并停用该 Key。 |
| `disable` | `PATCH { enabled: false }` | 停用「{label}」？停用后不再分配新请求，可在需要时手动恢复。 | 已停用「{label}」。 |
| `delete` | `DELETE /api/settings/jev/keys/{id}` | 删除 Key「{label}」？密钥密文会被清除，历史调用账本保留非敏感快照。 | 已删除 Key「{label}」。 |

确认弹窗按钮：`取消`（`variant="default"`，不产生请求）+ `确认`（`color="red"`，`loading={confirmBusy}`）。
「恢复」不是破坏性操作，不加确认（与现状一致）。

### 5.5 弹窗内反馈（R6）

`JevKeysPanel` 内定义一个小展示组件，**在三个 Modal body 里各渲染一次**：

```tsx
function PanelNotice({ notice, loadError }: { notice: Notice | null; loadError?: string | null }) {
  return (
    <>
      {loadError ? <Feedback kind="error">刷新失败：{loadError}（下方为上次成功数据）</Feedback> : null}
      {notice ? <Feedback kind={notice.kind === "success" ? "success" : "error"}>{notice.text}</Feedback> : null}
    </>
  );
}
```

- 顶层（当前可见的）弹窗总能看到结果；关闭编辑弹窗后同一条 notice 在管理弹窗里仍然可见。
- 打开编辑 / 确认弹窗前先 `setNotice(null)`，避免旧结果被读成新操作的结果。
- `loadError` 只在管理弹窗渲染（它就是 `settings.error` 的原文，措辞与页面顶部保持一致）。
- 页面顶部的 `reportResult` 继续服务 `JevForm` 保存与「测试连接」；密钥操作**不再**写页面顶部，
  避免同一条消息出现两遍。

### 5.6 只读表格与编辑表单的分工

`KeysModalBody`（管理弹窗 body，持有 `page`）：

1. `<PanelNotice …/>`
2. `<JevKeyAddForm onDone={…} onError={…} reload={props.reload} />`（**原组件原样搬过来**，不改结构：
   `className="row"` 已在 `globals.css` 里 `flex-wrap: wrap`，在 1200px 弹窗内正常；
   两个输入框的 `flex: 1 1 160px` / `2 1 260px` 也无需调整）
3. `keys.length === 0` → 空态段落；否则：
   - `<TableScroll label="Jev API 密钥列表" minTableWidth={1100}>` + 7 列表格，
     行内只有 `StatusBadge` / 纯文本 / 一个「编辑」按钮（`aria-label={`编辑「${label}」`}`）
   - `<Pagination page={safePage} total={keys.length} pageSize={JEV_KEYS_PAGE_SIZE} onPage={setPage} unit="个 Key" />`
     （`keys.length === 0` 时 `Pagination` 自身返回 `null`）

`KeyEditForm`（props：`item` / `busy` / `onDone` / `onError` / `onRequestConfirm` / `reload`）：

- 只读态：`<dl className="facts">` 展示 密钥状态（`secretStateLabel`）、启用状态（`StatusBadge`）、
  连续失败 `{n} / {JE_KEY_FAILURE_THRESHOLD}`、禁用原因 / 最近错误（都为空时 `—`）、最近使用（`formatTime`）、
  创建 / 更新时间（`formatTime`）。
- 名称：`TextInput defaultValue={item.label}` + `onBlur` 提交（空值回退），照搬 `component-guidelines.md`
  的「uncontrolled inputs committed on blur」模式。
- 密钥：`Fieldset legend="密钥"` + `Radio.Group`（保留 / 替换 / 清除）+ 条件 `PasswordInput` +
  「应用密钥变更」。`清除` 分支不复用 `window.confirm`，改为 `onRequestConfirm("clear")`。
- 操作行：`停用 / 恢复`（→ `onRequestConfirm("disable")`）、`测试`、`删除`（→ `onRequestConfirm("delete")`）。
- 表单自身的 `guard()` 只处理**非破坏性**写入：重命名、替换密钥、连接测试。
  这三类的请求、`busy`、文案与现状逐字一致（见 research §2.2）。
- `secretStateLabel` 定义为 `JevKeysPanel.tsx` 文件内的局部函数（唯一消费者）。

## 6. 「按 Key 汇总」（R5）

`JevUsagePanel` 内的 byKey 段落替换为 `<JevUsageByKey rows={usage.byKey} />`（`page.tsx` 内联组件）：

```tsx
function JevUsageByKey(props: { rows: JevUsageByKeyDto[] }) {
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState(0);
  const { rows } = props;
  if (rows.length === 0) return <p className="muted" style={{ margin: 0 }}>还没有按 Key 的调用记录。</p>;

  const total = rows.length;
  const safePage = clampPage(page, total, JEV_USAGE_BY_KEY_PAGE_SIZE);
  const preview = rows.slice(0, JEV_USAGE_BY_KEY_PREVIEW);

  return (
    <>
      <ByKeyTable rows={preview} label="按 Key 调用汇总（前 5 行预览）" />
      {total > JEV_USAGE_BY_KEY_PREVIEW ? (
        <div className="row">
          <Button variant="default" size="sm" onClick={() => { setPage(0); setOpened(true); }}>
            查看全部 {total} 个 Key
          </Button>
          <span className="muted small">按已知估算费用从高到低排序，这里只显示前 {JEV_USAGE_BY_KEY_PREVIEW} 行。</span>
        </div>
      ) : null}
      <Modal opened={opened} onClose={() => setOpened(false)} title={`按 Key 调用汇总（共 ${total} 个）`} size={1000} centered>
        <div className="stack">
          <ByKeyTable rows={pageSlice(rows, safePage, JEV_USAGE_BY_KEY_PAGE_SIZE)} label="按 Key 调用汇总（全部）" />
          <Pagination page={safePage} total={total} pageSize={JEV_USAGE_BY_KEY_PAGE_SIZE} onPage={setPage} unit="个 Key" />
        </div>
      </Modal>
    </>
  );
}
```

- `ByKeyTable({ rows, label })`：`<TableScroll label minTableWidth={900}>` + 8 列表格，
  单元格语义逐字沿用现有实现（含 `knownRequestCount === 0` → 「—（暂无可计价调用）」）。
  **同一个组件**用于预览与弹窗，避免两套单元格逻辑漂移（code-reuse guide）。
- 不复制 `byKey` 到 state；预览是 `rows.slice(0, 5)` 的即时派生。
- 预览区明确写出「这是预览、按什么排序」，满足诚实陈述限制的约定。
- 该弹窗**不**在 `Modal.Stack` 里（只有一层，不需要栈），与 `needs/page.tsx` 的既有弹窗一致。

## 7. 可访问性与样式

- 页面仍然只有一个 `h1`（`PageHeader`）；弹窗标题是 Mantine 的 `ModalTitle`，不是 `h1`/`h2`。
- 三个弹窗都 `centered`；`Modal` 自带 focus trap 与「关闭」按钮，`Escape` 只作用于栈顶。
- 表格全部包在 `TableScroll` 里并给 `minTableWidth`，窄屏横向滚动而不是压成一列一字。
- 「编辑」按钮有可见文字 + `aria-label` 带 Key 名称。
- 无新增 CSS：只用 `globals.css` 已有的 `.stack` / `.row` / `.muted` / `.small` / `.facts` /
  `.table-scroll` / `.pagination-bar` 与 Mantine props。
- 禁用状态色仍只由 `StatusBadge` 决定；文案仍只由 `api-types.ts` 的映射决定。

## 8. 验证矩阵

| # | 场景 | 可观察断言 | 手段 |
| --- | --- | --- | --- |
| V1 | `pageSlice` 空集 / 整除 / 末页不满 / 越界页码 / 非法页大小 / total 缩减 | 返回该页应有的元素，越界收敛到末页，非法返回 `[]` | `tests/components/pagination-model.test.ts` |
| V2 | 200+ Key 打开 `/jev` | 首屏无密钥表；`#jev-keys` 只有摘要 + 「管理密钥」 | 手工冒烟 |
| V3 | 打开管理弹窗 | 表格 10 行；`Pagination` 文案「共 N 个 Key · 第 1–10 个 Key」；翻到末页行数 `N mod 10` | 手工冒烟 |
| V4 | 新增密钥 | 列表出现新行、摘要总数 +1（`reload()` 后） | 手工冒烟 |
| V5 | 编辑六类操作 | 重命名 / 替换 / 清除 / 停用 / 恢复 / 测试 / 删除 结果文案出现在**弹窗内**；表格随之刷新 | 手工冒烟 |
| V6 | 破坏性确认 | 清除 / 停用 / 删除各弹确认框；取消后 Network 无请求；确认后数据更新；删除后编辑弹窗自动关闭 | 手工冒烟 + Network |
| V7 | 编辑弹窗数据新鲜度 | 重命名成功后弹窗标题与字段显示新值（`updatedAt` 变化触发重挂载） | 手工冒烟 |
| V8 | 确认失败 | 断网 / 造 4xx → 错误反馈出现在确认弹窗内，弹窗保持打开可重试 | 手工冒烟 |
| V9 | 按 Key 汇总 | 页面 5 行预览 + 「查看全部 N 个 Key」；弹窗内分页 10 行；`N ≤ 5` 时无按钮；`N = 0` 时只有空态段落 | 手工冒烟 |
| V10 | 空集 | `keys = 0` 时空态段落 + 按钮仍可点开弹窗新增 | 手工冒烟 |
| V11 | 浅色 / 深色 | 弹窗、表头对比度、发丝线、徽标、分页条、危险按钮均正常 | 手工冒烟 |
| V12 | 静态检查 | `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 全绿；`/api/*` 仍是 `ƒ` | 命令 |
| V13 | 无 `window.confirm` | `grep -n "window.confirm" src/components/JevKeysPanel.tsx src/app/\(admin\)/jev/page.tsx` 无输出 | 命令 |
| V14 | 无硬编码颜色 | `grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 无输出 | 命令 |

## 9. 风险与规避

| 风险 | 规避 |
| --- | --- |
| `stackId` 与 `Modal.Stack` 配错 → z-index / Escape / focus trap 失效 | 三个 `Modal` 全部在同一个 `<Modal.Stack>` 内且各带唯一 `stackId`；栈顶判定依赖 `opened` 的转换顺序（先基础、后编辑、再确认） |
| 弹窗宽度写成 CSS 字符串 → 无效 `var(--modal-size-…)` | 只用数字（`size={1200}` / `size={1000}`）或内置尺寸名 |
| `reload()` 后编辑弹窗显示旧值 | `editingKey` 每次渲染从 `props.keys` 派生；`KeyEditForm` 用 `${id}:${updatedAt}` 做 key |
| Key 在别处被删除后编辑弹窗残留 | `opened={editingKey !== null}`，Key 消失即自动关闭 |
| 反馈被遮罩挡住（R6 的核心风险） | notice 在三个 Modal body 内都渲染；页面顶部不再重复同一消息 |
| 预览表与弹窗表逻辑漂移 | 同一个 `ByKeyTable` 组件供两处使用 |
| 200 行 Mantine 控件拖慢首屏 | 表格只在弹窗打开时渲染（`keepMounted: false` + body 子组件） |
| 误用「渲染期 setState」触发 lint | 客户端分页只用纯派生 `safePage`，不写 state |

## 10. 回滚

纯前端、无迁移、无数据写入形状变化：`git revert` 该提交即可恢复原状，
不需要数据修复或补偿脚本。若只想临时关闭，把 `#jev-keys` 的按钮与 `JevKeysPanel` 摘掉不影响其它区块。
