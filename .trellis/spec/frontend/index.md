# Frontend Development Guidelines

> Admin UI conventions for this project.

---

## Overview

The frontend is Next.js App Router with a deliberate split:

- **Server components** own access control and page shell: `src/app/(admin)/layout.tsx` reads the
  session cookie and `redirect("/login")` when absent.
- **Client components** own interaction: forms, tables, badges. They read data exclusively through
  `/api/*` with the shared `api-client` helper.

There is no state library, no UI kit, no Tailwind. Styling lives in `src/app/globals.css`.

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
