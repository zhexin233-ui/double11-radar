# Frontend Development Guidelines

> Admin UI conventions for this project.

---

## Overview

The frontend is Next.js App Router with a deliberate split:

- **Server components** own access control and page shell: `src/app/(admin)/layout.tsx` reads the
  session cookie and `redirect("/login")` when absent.
- **Client components** own interaction: forms, lists, badges. They read data exclusively through
  `/api/*` with the shared `api-client` helper.

Styling has two layers and the boundary is enforced by convention (2026-10 起):

| 层 | 归谁 | 内容 |
| --- | --- | --- |
| 交互原语 + 主题 | **Mantine v9**（`@mantine/core`） | 按钮、输入框、下拉、开关、勾选、分页、对话框、`Alert`、`Badge`，以及浅色/深色/跟随系统三态主题 |
| 排版与结构 | `src/app/globals.css` | 令牌、页面壳层、区块、**编辑式条目列表**、`table` 元素本身、反馈区域布局 |

没有状态管理库，没有 Tailwind，没有 CSS-in-JS。`globals.css` 里的颜色令牌一律别名到 Mantine 的
CSS 变量（见 `quality-guidelines.md` 的主题章节），因此自定义 CSS 自动跟随深色主题。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Page and component layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Composition, keyed forms, badges | Filled |
| [Hook Guidelines](./hook-guidelines.md) | `useApiResource` and re-entrancy | Filled |
| [State Management](./state-management.md) | Server data vs form state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Lint rules and copy conventions | Filled |
| [Type Safety](./type-safety.md) | `api-types.ts` and the client boundary | Filled |

---

## Three rules that keep this UI honest

1. Never render "没有匹配" when processing actually failed — use
   `STATUS_LABELS[detail.status]`, which distinguishes `matched` / `uncertain` / `failed` /
   `not_matched`.
2. Never display a program-generated explanation as a model justification. The label
   「程序生成的分类说明」 must stay next to it.
3. Credentials are edited with an explicit **保留 / 替换 / 清除** control. An empty input means
   "keep", never "clear".

## 四条结构规则（2026-10 增补）

1. 页面容器、区块、条目列表、表格元素本身**不得**换成 Mantine 组件；库只负责交互控件与主题。
2. 每个页面先在浅色下看一遍，再在深色下看一遍（顶栏「外观」可切三态），对比不足视为未完成。
3. 列表要么有分页，要么在 `design.md`/PRD 里有「为什么不分页」的书面理由。
4. 每页恰好一个 `h1`；条目的标题是链接时，行内其他控件不得嵌套在链接里。
