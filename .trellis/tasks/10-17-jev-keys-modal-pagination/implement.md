# 执行计划：Jev 密钥列表与按 Key 汇总改为弹窗分页表格

> 仅规划。不得因本文件存在而直接 `task.py start`；用户明确批准本规划后才进入实施（Phase 1.4）。
> 需求见 `prd.md`，技术设计见 `design.md`，代码事实见 `research/current-behavior.md`。

## 0. 前置核对

- [ ] 重读 `prd.md` / `design.md`，确认四条用户决策未变：密钥区整块进弹窗、列表只读 + 编辑弹窗、
      每页 10 条、按 Key 汇总保留 Top-5 预览。
- [ ] 读取 `.trellis/spec/frontend/{index,component-guidelines,quality-guidelines,type-safety,directory-structure}.md`
      与 `.trellis/spec/guides/code-reuse-thinking-guide.md`（`implement.jsonl` 的清单）。
- [ ] 读取将改动的**确切代码**：`src/app/(admin)/jev/page.tsx` 全文、`src/components/ui/{Pagination,TableScroll,Section,Feedback}.tsx`、
      `src/components/pagination-model.ts`、`src/components/api-types.ts:100-205,505-525`、
      `src/app/(admin)/needs/page.tsx:219-250`（受控 Modal 范例）。
- [ ] 读取 `node_modules/@mantine/core/lib/components/Modal/{Modal,ModalStack,use-modals-stack}.d.ts`
      确认 `stackId` / `size` 的签名（research §5 已记录源码事实，但实施前再核对一次版本没变）。
- [ ] 记录基线：`git status` 干净、`pnpm typecheck` / `pnpm test` 当前是否通过（基线失败要先报告，不能算作本次回归）。

## 1. 纯逻辑与常量（R7）

- [ ] `src/components/pagination-model.ts`：新增 `pageSlice<T>(items, page, pageSize): T[]`
      （实现与注释见 `design.md` §4.1；空集、非法页大小返回 `[]`，其余先 `clampPage`）。
- [ ] `tests/components/pagination-model.test.ts`：新增 `pageSlice` 用例——空集、整除、末页不满、
      越界页码收敛到末页、非法页大小（0 / 负数 / `NaN`）、`total` 缩减后从末页取到正确切片。
- [ ] `src/components/api-types.ts`：在 `CHANNELS_PAGE_SIZE` 之后加 `JEV_KEYS_PAGE_SIZE = 10`、
      `JEV_USAGE_BY_KEY_PAGE_SIZE = 10`、`JEV_USAGE_BY_KEY_PREVIEW = 5`，各带一行注释说明是客户端展示参数。
- [ ] `src/components/format.ts`：新增，导出 `formatTime(value: string | null): string`
      （逻辑逐字照搬 `page.tsx:44-48`：`null` → `—`，`NaN` → `—`，否则 `toLocaleString()`）。
- [ ] `pnpm test -- pagination-model` 通过。

## 2. 密钥管理弹窗（R1 / R2 / R3 / R4 / R6）

新建 `src/components/JevKeysPanel.tsx`（`"use client"`），从 `page.tsx` **原样搬移**再改造：

- [ ] 搬移 `JevKeyAddForm`（`page.tsx:228-289`）：逻辑、校验、文案不变，`onDone` / `onError` / `reload` props 不变。
- [ ] 新增 `secretStateLabel`（从 `page.tsx:55-59` 搬移，本文件唯一消费者）。
- [ ] 新增 `PanelNotice({ notice, loadError? })`：`loadError` → `Feedback kind="error"`（措辞与页面顶部一致），
      `notice` → `Feedback kind={notice.kind}`。
- [ ] 新增 `JevKeysTable({ rows, onEdit })`：`TableScroll label="Jev API 密钥列表" minTableWidth={1100}` +
      7 列只读表格（名称 / 密钥 / 状态 / 计数 / 禁用原因·最近错误 / 最近使用 / 操作）；
      「编辑」按钮带 `aria-label={`编辑「${label}」`}`；所有空值渲染 `—` 的规则与现状逐字一致。
- [ ] 新增 `KeysModalBody`：持有 `page` state；渲染 `PanelNotice` + `JevKeyAddForm` + 空态或
      (`JevKeysTable` + `Pagination unit="个 Key"`)，分页用 `clampPage` + `pageSlice`。
- [ ] 新增 `KeyEditForm`（props：`item` / `busy` / `onDone` / `onError` / `onRequestConfirm`）：
      - `dl.facts` 只读态（密钥状态 / 启用状态 / 连续失败 `{n} / {JE_KEY_FAILURE_THRESHOLD}` / 禁用原因·最近错误 / 最近使用 / 更新时间）；
      - `TextInput defaultValue={label}` + `onBlur` 提交（非空且不同才发；空值回退）；
      - `Fieldset legend="密钥"` + `Radio.Group`（保留 / 替换 / 清除）+ 条件 `PasswordInput` + 「应用密钥变更」；
      - 操作行：停用·恢复 / 测试 / 删除；
      - 自身 `guard()` 只处理重命名、替换密钥、连接测试（文案与现状逐字一致，见 research §2.2）；
      - 清除 / 停用 / 删除一律走 `onRequestConfirm(kind)`，**不得**出现 `window.confirm`。
- [ ] `KeyEditForm` 内 `busy` 只覆盖它自己发起的请求；删除/停用等由父级 `confirmBusy` 控制。
- [ ] `JevKeysPanel` 容器：`notice` / `editingKeyId` / `pendingConfirm` / `confirmBusy` state；
      `editingKey = props.keys.find(...) ?? null` 每渲染派生；
      实现 `guard` / `requestConfirm` / `confirmPending` / `finishEdit` / `failEdit`（见 `design.md` §5.2）。
- [ ] `confirmPending` 按 `kind` 走清除 / 停用 / 删除三条路径；删除成功后**同时**关编辑弹窗；
      失败时保持确认弹窗打开并把错误写进 `notice`。
- [ ] `Modal.Stack` 包住三个 `Modal`，各带唯一 `stackId`（`jev-keys` / `jev-key-edit` / `jev-confirm`）；
      基础弹窗 `opened` 来自 props，编辑弹窗 `opened={editingKey !== null}`，
      确认弹窗 `opened={pendingConfirm !== null}`；`size={1200}` / `"lg"` / 默认，均 `centered`。
- [ ] 打开编辑或确认弹窗前 `setNotice(null)`；基础弹窗 `onClose` 同时清 `editingKeyId` / `pendingConfirm` / `notice`。
- [ ] 三个 Modal body 里都渲染 `PanelNotice`（`loadError` 只给基础弹窗）。

## 3. 页面接线（R1 / R5）

`src/app/(admin)/jev/page.tsx`：

- [ ] 删除 `JevKeyAddForm`（228-289）与 `JevKeyRow`（291-492）两个组件定义；
      删除本地 `formatTime`（44-48）改为 `import { formatTime } from "@/components/format"`。
- [ ] 新增 `import { JevKeysPanel } from "@/components/JevKeysPanel"`、
      `import { pageSlice } from "@/components/pagination-model"`、
      以及 `JEV_USAGE_BY_KEY_PAGE_SIZE` / `JEV_USAGE_BY_KEY_PREVIEW` 常量导入。
      清理因此不再使用的 `Fieldset` / `PasswordInput` / `TextInput` / `Radio` / `StatusBadge` /
      `JE_KEY_FAILURE_THRESHOLD` / `SecretStateDto` / `JevKeyDto` 等导入——只有在确认无其它消费者后才删，
      以 `pnpm lint` 的 `no-unused-vars` 为准。
- [ ] `JevPage` 增加 `const [keysOpened, setKeysOpened] = useState(false)`；
      `#jev-keys` 区块改为 `<Section actions={<Button …>管理密钥</Button>}>` + 摘要/空态段落（`design.md` §5.1），
      `id` / `description` / 锚点导航不变；区块后挂 `<JevKeysPanel … />`。
- [ ] `JevUsagePanel` 内新增 `ByKeyTable({ rows, label })` 与 `JevUsageByKey({ rows })` 两个内联组件，
      替换 546-596 行的 byKey 表格块（标题 `<h3>按 Key 汇总</h3>` 保留在本面板内）。
      `JevUsageByKey` 行为与文案严格按 `design.md` §6。
- [ ] 确认 `JevUsagePanel` 的 summary / 「最近调用」/ `Pagination`（`USAGE_PAGE_SIZE = 20`）未被改动。
- [ ] 确认页面仍然只有一个 `h1`（`PageHeader`）。

## 4. 代码质量自查

- [ ] 无 `window.confirm`、无 `alert`：`grep -n "window.confirm\|alert(" src/components/JevKeysPanel.tsx "src/app/(admin)/jev/page.tsx"` 无输出。
- [ ] 无 `useEffect` 新增；无 `setState` 在渲染期（`react-hooks/set-state-in-effect` /
      `set-state-in-render`）；`safePage` 是纯派生。
- [ ] 无 `as` 断言、无 `any`；DTO 全部来自 `api-types.ts`。
- [ ] 无魔法页大小数字（一律引用常量）；无重复的分页数学（一律 `clampPage` / `pageSlice` / `Pagination`）。
- [ ] 无硬编码颜色；无新增 `globals.css` 规则。
- [ ] 预览表与弹窗表共用 `ByKeyTable`；密钥读取态文案共用 `secretStateLabel`；
      时间格式化只有 `format.ts` 一处（jev 范围内）。
- [ ] 复用检查（`code-reuse-thinking-guide.md` 的提交前清单）：
      `grep -rn "pageSlice\|JEV_KEYS_PAGE_SIZE\|JEV_USAGE_BY_KEY_PAGE_SIZE\|JEV_USAGE_BY_KEY_PREVIEW\|formatTime" src/`
      逐个确认都是导入而非重新定义。

## 5. 验证

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`（确认 `/api/*` 仍是动态 `ƒ`，`/` 与 `/login` 仍是静态）
- [ ] `grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 无输出
- [ ] 手工冒烟（`pnpm dev`，登录后 `/jev`）逐条走 `design.md` §8 的 V2—V11：
      - 200+ Key 首屏无长表；管理弹窗 10 行/页、末页行数正确；
      - 新增 / 重命名 / 替换 / 清除 / 停用 / 恢复 / 测试 / 删除八条路径，反馈都在弹窗内可见；
      - 清除 / 停用 / 删除的确认框「取消」不发请求（看 Network）；删除后编辑弹窗自动关闭；
      - 重命名成功后弹窗内显示新值；
      - 按 Key 汇总 5 行预览 + 「查看全部」弹窗分页；`N ≤ 5` 与 `N = 0` 两种情况；
      - 浅色与深色各看一遍；dev console 无 hydration 警告。

## 6. 回滚点

| 回滚点 | 触发条件 | 动作 |
| --- | --- | --- |
| R-a：`pageSlice` + 常量 + `format.ts`（第 1 节） | 单测不通过 | 只回退这三个文件，不涉及页面 |
| R-b：`JevKeysPanel.tsx`（第 2 节） | 弹窗栈行为异常且无法在本次收敛 | 删除新文件，保留页面原状（第 3 节未做时无影响） |
| R-c：页面接线（第 3 节） | 冒烟发现阻塞缺陷 | `git checkout -- "src/app/(admin)/jev/page.tsx"` 并重新规划，不留半成品 |
| R-d：整体 | 任何已提交的缺陷 | `git revert <commit>`；纯前端、无迁移、无数据修复 |

## 7. 收尾（Phase 3）

- [ ] 3.3 把本次新增的约定写回 spec：
      `frontend/component-guidelines.md`（`Modal.Stack` + `stackId` 的弹窗栈用法、客户端分页
      `clampPage` + `pageSlice` 的写法与「不用渲染期 setState」的理由）、
      `frontend/type-safety.md`（三个客户端展示常量的性质：**无**服务端镜像、不属于「两边必须同步」的常量）、
      `guides/code-reuse-thinking-guide.md`（`formatTime` 已在 6 处重复 → 本任务只统一 jev 范围，
      其余页面作为后续候选列出）。
- [ ] 3.4 提交（中文 conventional commit，单提交包含代码 + 测试 + spec 更新）。
