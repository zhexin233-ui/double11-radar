# 现状调研：Jev 页面两处未分页列表

调研日期 2026-10-17。所有行号以当前工作树（`main`，`4f4dba8`）为准。
本文件只记录**代码事实**与 API 契约，不包含方案。

## 1. 页面结构

文件 `src/app/(admin)/jev/page.tsx`（856 行，`"use client"`），单页 5 个区块：

| 区块 id | 标题 | 内容 | 行号 |
| --- | --- | --- | --- |
| `jev-connection` | 连接与调度 | `JevForm` + 「测试连接」按钮 | 758—781 |
| `jev-keys` | API 密钥 | `JevKeyAddForm` + `data.keys` 全量表格 | 782—826 |
| `jev-usage` | 费用与用量 | `JevUsagePanel` | 831—850 |
| — | 需求试判 | `DryRunPanel` | 852 |

页锚点导航（`anchor-nav`）在 740—746 行，链接到 `#jev-connection` / `#jev-strategy` / `#jev-keys` /
`#jev-usage` / `#jev-dry-run`。`#jev-strategy` 是 `JevForm` 内部的 `Fieldset` id（107 行）。

## 2. 组件与行号锚点

| 符号 | 位置 | 说明 |
| --- | --- | --- |
| `USAGE_PAGE_SIZE = 20` | `page.tsx:42` | 页面内局部常量（**不在** `api-types.ts`） |
| `formatTime` | `page.tsx:44` | `null` → `—` |
| `toNumber` | `page.tsx:51` | `NumberInput` 值收窄 |
| `secretStateLabel` | `page.tsx:55` | `unreadable` → 「无法解密（加密密钥可能已变更）」/「未配置」/「已配置 {masked}」/「已配置」 |
| `JevForm` | `page.tsx:66` | keyed by `data.version`；本任务不动 |
| `JevKeyAddForm` | `page.tsx:228` | `POST /api/settings/jev/keys`；`className="row"` 三列（名称 / 密码 / 按钮） |
| `JevKeyRow` | `page.tsx:291` | 一个 `<tr>`：7 列，最后一列含 `Fieldset`（保留/替换/清除）+ 「应用密钥变更」+ 停用/恢复 + 测试 + 删除 |
| `JevUsagePanel` | `page.tsx:497` | summary `dl.facts` + 「按 Key 汇总」表（546） + 「最近调用」表（604）+ `Pagination`（641） |
| `JevPage` | `page.tsx:656` | `useApiResource` × 2 + `usagePage` state |

### 2.1 三处 `window.confirm`（必须被替换）

| 行号 | 操作 | 现有文案 |
| --- | --- | --- |
| 329 | 清除密钥 | `清除「${item.label}」的密钥？清除后会停用该 Key，需要替换密钥后才能再次启用。` |
| 355 | 停用 | `停用「${item.label}」？停用后不再分配新请求，可在需要时手动恢复。` |
| 379 | 删除 | `删除 Key「${item.label}」？密钥密文会被清除，历史调用账本保留非敏感快照。` |

### 2.2 `JevKeyRow` 的请求契约（保持不变）

```
PATCH  /api/settings/jev/keys/{id}  { label }              // 重命名
PATCH  /api/settings/jev/keys/{id}  { apiKey }             // 替换
PATCH  /api/settings/jev/keys/{id}  { apiKey: { clear: true } }  // 清除（服务端同时停用）
PATCH  /api/settings/jev/keys/{id}  { enabled }            // 启停 / 恢复
POST   /api/settings/jev/test       { keyId }              // 连接测试 → TestResultDto
DELETE /api/settings/jev/keys/{id}                         // 删除
```

`guard()`（`page.tsx:305`）统一：`busy` 开关 → 成功后重置 `secretAction="keep"` / `secret=""` →
`props.onDone(message)` → `await props.reload()`；异常走 `props.onError(errorMessage(caught))`。

重命名是**失焦提交**：`onBlur` 里 `next` 非空且 ≠ 原值才提交，空值回退 `item.label`
（`component-guidelines.md` 的「uncontrolled inputs committed on blur」模式）。

`JevKeyRow` 的 React key 是 `` `${item.id}:${item.updatedAt}` ``（`page.tsx:812`）——
任何写入都会改 `updatedAt`，从而整行/整个弹窗重挂载并显示最新值。

## 3. 服务端契约（本任务不改）

### 3.1 `/api/settings/jev`（GET）

`src/app/api/settings/jev/route.ts`（`ok(...)` 包装）。响应 = `JevSettingsDto extends JevConfigDto` +
`keys: JevKeyDto[]`。**`keys` 是一次性完整数组，无 `limit` / `offset` / `total`。**

`JevKeyDto`（`api-types.ts:115`）：`id` / `label` / `generation` / `enabled` / `disabledReason` /
`consecutiveFailures` / `lastError` / `lastUsedAt` / `createdAt` / `updatedAt` / `secretState`。
`secretState: SecretStateDto = { configured, masked, unreadable }`。

### 3.2 `/api/settings/jev/usage`（GET）

`src/app/api/settings/jev/usage/route.ts`：`parsePageQuery(url.searchParams, { defaultLimit: 20, maxLimit: 200 })`
**只作用于 `recent`**（`listRecentJevRequests`）。`byKey` 是完整数组，无分页参数：

```ts
getJevUsageView(db, { limit, offset }) -> {
  summary,                       // 与分页无关
  byKey: JevUsageByKeyView[],    // 全量，按 knownCostNanos DESC, requestCount DESC
  recent: { items, total },
}
```

`src/lib/db/repos/jev-requests.ts:426` 的 `getJevUsageByKey` 走
`GROUP BY key_id ORDER BY knownCostNanos DESC, requestCount DESC`。
`key_id` 可为 `NULL`（Key 已删除）→ 前端渲染「未关联 Key」，因此 `byKey` 行数**不是**当前 Key 数，
会随历史账本增长。

`JevUsageByKeyDto`（`api-types.ts:185`）：`keyId` / `keyLabel` / `requestCount` /
`knownRequestCount` / `knownCostNanos` / `knownCostUsd` / `unknownCostCount` / `inputTokens` /
`outputTokens` / `failedCount`。

## 4. 可复用的既有件

| 件 | 位置 | 契约 |
| --- | --- | --- |
| `Pagination` | `src/components/ui/Pagination.tsx` | `{ page (0 基), total, pageSize, onPage, unit?, note? }`；`total === 0` 返回 `null`；内部 `clampPage` 兜底 |
| `clampPage` / `pageCount` / `pageRange` | `src/components/pagination-model.ts` | 纯函数，已有单测 `tests/components/pagination-model.test.ts` |
| `TableScroll` | `src/components/ui/TableScroll.tsx` | `{ label (必填), minTableWidth?, className? }` → `role="region"` + `aria-label` + `tabIndex=0`；`--table-min` 由 `globals.css:678` 消费 |
| `Section` | `src/components/ui/Section.tsx` | 支持 `actions`（区块头部右侧）与 `id` |
| `Feedback` | `src/components/ui/Feedback.tsx` | `kind: loading \| success \| error \| notice` |
| `StatusBadge` | `src/components/status-badge.tsx` | 唯一「状态 → 颜色」映射 |
| `useApiResource` | `src/components/use-api.ts` | 唯一允许在 effect 内触发加载的地方 |
| `apiSend` / `errorMessage` | `src/components/api-client.ts` | `401` → `window.location.replace("/login")` |
| 页大小常量 | `src/components/api-types.ts:515—521` | `BULLETIN_PAGE_SIZE=50`、`NEEDS_PAGE_SIZE=10`、`CHANNELS_PAGE_SIZE=20` |

## 5. `@mantine/core` v9.7.2 事实（已读源码，非文档推测）

- `Modal` 支持 `size`（`getSize(size, "modal-size")`）：
  - 字符串 `xs|sm|md|lg|xl` → `var(--modal-size-*)`，`--modal-size-xl = 48.75rem (780px)`；
  - **数字** → `rem(n)`，即 `size={1200}` → `--modal-size: 1200px`（可用）；
  - 任意 CSS 字符串（如 `"min(1200px, 96vw)"`）会变成 `var(--modal-size-min(...))` —— **不可用**。
  - `.m_54c44539 { flex: 0 0 var(--modal-size); max-width: 100% }`，`--modal-inner-x-offset: 5vw`
    → 超宽弹窗在窄屏自动收敛到 90vw。
- `Modal.Stack`（`ModalStackContext`）+ `useModalsStack(ids)`（两处都从 `@mantine/core` 导出）：
  - `Modal` 只有拿到 `stackId` **且**处于 `ModalStackContext` 内时才会启用栈管理：
    `closeOnEscape` / `trapFocus` 只对 `ctx.currentId === stackId` 生效，`zIndex` 为
    `calc(maxZIndex + index + 1)`，非栈顶的 `ModalContent` 带 `data-hidden`（`opacity:0; pointer-events:none`）。
  - `useModalsStack(...).register(id)` 返回 `{ opened, onClose, stackId }`，直接展开给 `Modal`。
  - `ModalStack` 是一个提供 context 的组件，必须**包住**这些 `Modal`。
- `Modal` 默认 `keepMounted: false` → 关闭后内容卸载。
- `@mantine/modals` **未安装**（`node_modules/@mantine/` 只有 `core` 与 `hooks`），
  没有命令式 `modals.openConfirmModal`；确认弹窗必须是受控 `Modal`。

## 6. 测试基建事实

- `vitest`：`environment: "node"`，`include: ["tests/**/*.test.ts"]`（无 `.tsx`），
  `setupFiles: ["tests/setup.ts"]`，alias `@` → `src`。
- **没有** `@testing-library/react` / `jsdom` / `happy-dom` devDependency
  → 本任务**无法**加组件渲染测试；组件层只能靠 `typecheck` / `lint` / `build` + 手工冒烟。
- 纯逻辑测试的既有范例：`tests/components/pagination-model.test.ts`（`describe` 中文标题 +
  `it` 覆盖空集 / 整除 / 越界 / 非法输入）。

## 7. 现有的「弹窗」范例

`src/app/(admin)/needs/page.tsx:219—250`：受控 `Modal`（`opened={pendingDelete !== null}` /
`onClose` / `title` / `centered`），内部 `.stack` + 文案 + 右对齐 `.row` 的「取消 / 删除」按钮，
危险按钮 `color="red"` 且 `loading={busy}`。这是本任务确认弹窗的直接模板（**不用** `Modal.Stack`，
因为只有一层）。
