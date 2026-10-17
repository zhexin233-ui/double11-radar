# Jev 页面密钥列表与按 Key 汇总改为弹窗分页表格

## 背景 / 问题

`src/app/(admin)/jev/page.tsx` 有两处长列表**没有分页**，当前有约 200 个 Key 时会把整张表铺满页面：

1. **API 密钥**（`#jev-keys` 区块）：`data.keys.map((item) => <JevKeyRow …>)` 全量渲染，
   200 行 × 每行含 `TextInput` + `Radio.Group` + `PasswordInput` + `Button`，首屏 DOM 极重，
   页面被拉成一条长卷。
2. **按 Key 汇总**（`#jev-usage` 区块内 `JevUsagePanel`）：`usage.byKey.map(…)` 全量渲染。
   该聚合按 `key_id` 分组，包含已删除 Key 的历史记录（`keyLabel` 为「未关联 Key」），
   行数会随历史增长超过当前 Key 数。

这违反 `frontend/index.md` 的结构规则 3：「列表要么有分页，要么在 PRD/design 里有『为什么不分页』的书面理由」。

## 目标

两处都变成「页面给摘要与入口按钮 → 点击后弹窗里放**分页**表格」。密钥的写操作（重命名、密钥替换/清除、
启停、连接测试、删除）整体搬进弹窗，页面本身不再铺开密钥表。

## 需求

### R1 — `#jev-keys` 区块只保留摘要与入口按钮

- 页面上不再渲染密钥表格，也不再渲染「添加密钥」表单。
- 区块内显示摘要：共 N 个 Key、其中 M 个启用；N = 0 时显示空态文案（保留现有措辞
  「还没有配置 Jev 密钥。添加后，后台判断、连接测试与需求试判都会从密钥池调度。」）。
- 区块头部（`Section.actions`）放一个按钮「管理密钥」，点击打开密钥管理弹窗。
- 区块 `id="jev-keys"`、锚点导航项与 `description` 的解释文案保持不变。

### R2 — 密钥管理弹窗（只读分页表 + 新增表单）

- 弹窗标题体现这是密钥池管理（例：「Jev API 密钥」），并在标题或正文显示 `共 N 个 · M 个启用`。
- 弹窗内包含「添加密钥」表单（现有 `JevKeyAddForm` 的能力与校验不变：名称 ≤ 100 字、密钥 ≤ 500 字、
  失败反馈与成功后清空输入）。
- 弹窗内包含**只读**表格，列为：名称 / 密钥 / 状态 / 连续失败 / 禁用原因·最近错误 / 最近使用 / 操作。
  列语义与当前 `JevKeyRow` 展示一致（`secretStateLabel`、`StatusBadge`、`{n} / {JE_KEY_FAILURE_THRESHOLD}`、
  `formatTime`、空值渲染 `—`）。
- 表格每页 10 条，底部用 `Pagination` 显示「共 N 条 · 第 x–y 条」与页码。
- 「操作」列只有一个按钮「编辑」，点击打开编辑弹窗（R3）。
- 空集时渲染空态段落，不渲染空 `<table>`。

### R3 — 编辑密钥弹窗

编辑弹窗必须保留当前行内的全部能力，不得缩水：

| 能力 | 行为 |
| --- | --- |
| 重命名 | 文本框失焦提交（非空且与原值不同才提交；空值回退原值），沿用 `PATCH { label }` |
| 密钥变更 | 保留 / 替换 / 清除 三态（`Radio.Group`）；替换需要非空 `PasswordInput`；沿用 `PATCH { apiKey }` / `PATCH { apiKey: { clear: true } }` |
| 启停 / 恢复 | `PATCH { enabled }`，切换前必须确认（见 R4） |
| 连接测试 | `POST /api/settings/jev/test { keyId }`，失败必须报错而不是本地伪造成功 |
| 删除 | `DELETE /api/settings/jev/keys/{id}`，删除前必须确认（见 R4） |

- 弹窗内展示该 Key 的只读态信息（密钥状态、启用状态、连续失败、禁用原因 / 最近错误、最近使用）。
- 服务端返回数据变化后（`reload()` 后 `updatedAt` 变化），编辑弹窗必须显示最新值，不能停留在提交前的旧值。

### R4 — 破坏性操作用确认弹窗，不再用 `window.confirm`

`清除密钥` / `停用` / `删除` 三个操作改为确认弹窗（`Modal`，可键盘操作），确认文案沿用现有措辞：

- 清除：「清除「{label}」的密钥？清除后会停用该 Key，需要替换密钥后才能再次启用。」
- 停用：「停用「{label}」？停用后不再分配新请求，可在需要时手动恢复。」
- 删除：「删除 Key「{label}」？密钥密文会被清除，历史调用账本保留非敏感快照。」

确认按钮用危险样式，`loading={busy}` 防重复提交；取消不产生任何请求。
本任务范围内 `src/app/(admin)/jev/page.tsx` 不得再新增 `window.confirm`（现有的三个必须被替换掉）。

### R5 — 「按 Key 汇总」页面保留 Top-N 预览，完整表进弹窗

- 页面在「按 Key 汇总」标题下渲染**前 5 行**预览表（沿用服务端返回的顺序：
  `knownCostNanos DESC, requestCount DESC`），并明确说明这是预览而非全部。
- 预览旁边/下方给一个按钮「查看全部 N 个 Key」，点击打开弹窗，弹窗内是同一张表的分页版本（每页 10 条）。
- `usage.byKey.length === 0` 时保留现有空态「还没有按 Key 的调用记录。」，不显示按钮。
- `usage.byKey.length <= 5` 时不显示「查看全部」按钮（没有更多内容）。
- 表格列与单元格语义与当前实现一致：Key / 实际调用 / 已计价 / 未知费用 / 失败 / 输入 Token / 输出 Token /
  已知估算费用，其中 `knownRequestCount === 0` 时显示「—（暂无可计价调用）」而不是 `$0.00`。

### R6 — 弹窗内的操作反馈必须可见

密钥操作的结果（成功 / 失败）不能只写到页面顶部的提示区——弹窗打开时它被遮罩挡住，用户看不到。
反馈必须渲染在用户当前能看到的弹窗内。

### R7 — 复用既有分页与常量

- 分页纯函数复用 `src/components/pagination-model.ts`，不得在两个组件里各写一遍 `slice` / `clamp` 数学。
- 页大小常量集中在 `src/components/api-types.ts`（客户端唯一来源），组件不写魔法数字。

## 非目标

- **不改服务端**：`/api/settings/jev` 仍返回完整 `keys` 数组，`/api/settings/jev/usage` 仍返回完整 `byKey`。
  本任务只做前端分页（见 `design.md` 的取舍说明）。
- 不新增搜索、筛选、排序、批量操作、批量删除。
- 不改 `JevForm`（连接与调度）、`DryRunPanel`（需求试判）、「测试连接」按钮的行为与位置。
- 不改 `globals.css` 的令牌与主题机制，不引入新的主题系统或 UI 库。
- 不改 DTO 字段与服务端接口形状。

## 验收标准

- [ ] **AC1**：在有 200+ 个 Key 的环境下打开 `/jev`，首屏不再出现密钥表；`#jev-keys` 只有摘要与「管理密钥」按钮。
- [ ] **AC2**：点击「管理密钥」→ 弹窗内表格每页 10 行，`Pagination` 显示「共 N 条 · 第 1–10 条」，翻页后行内容变化，末页行数正确（`N mod 10`）。
- [ ] **AC3**：弹窗内「添加密钥」成功后再关弹窗，摘要里的总数 +1；新 Key 出现在列表里。
- [ ] **AC4**：点某行「编辑」→ 能完成重命名、替换密钥、清除密钥、停用/恢复、连接测试、删除全部六类操作；结果反馈在弹窗内可见。
- [ ] **AC5**：清除 / 停用 / 删除各自弹出确认弹窗；取消后不发请求；确认后表格数据刷新。`grep -n "window.confirm" src/app/(admin)/jev/page.tsx` 无输出。
- [ ] **AC6**：`#jev-usage` 的「按 Key 汇总」页面只显示前 5 行 + 「查看全部 N 个 Key」；点开后弹窗内是完整分页表（每页 10 条）。
- [ ] **AC7**：`byKey.length <= 5` 时不显示「查看全部」按钮；`keys.length === 0` 与 `byKey.length === 0` 都渲染段落空态而不是空表格。
- [ ] **AC8**：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过；`build` 里 `/api/*` 仍为动态路由。
- [ ] **AC9**：浅色与深色主题下各看一遍 `/jev`：弹窗、表格表头对比度、发丝线、状态徽标、分页条均正常；无 hydration 警告。
- [ ] **AC10**：`pagination-model` 新增纯函数有单测覆盖（空集、末页、越界页码、total 缩减）。
- [ ] **AC11**：页面仍然只有一个 `h1`（`PageHeader`），表格仍包在 `TableScroll` 里并带 `minTableWidth`。

## 风险与已确认的用户决策

| 决策点 | 结论（用户已确认） |
| --- | --- |
| 密钥区布局 | **整个密钥操作都进弹窗**：页面只留摘要 + 按钮，新增表单与列表都在弹窗里 |
| 弹窗内操作能力 | 列表**只读** + 每行「编辑」按钮，编辑弹窗里保留完整操作 |
| 每页条数 | **10 条**（密钥表、按 Key 汇总表都是） |
| 按 Key 汇总页面表现 | **保留 Top-N 预览**（N = 5）+ 「查看全部」按钮 |

## 备注

- 本任务判定为复杂任务：需要 `design.md` 与 `implement.md`，在 `task.py start` 之前完成。
- 前端规范约束见 `.trellis/spec/frontend/{index,component-guidelines,quality-guidelines,type-safety,directory-structure}.md`。
