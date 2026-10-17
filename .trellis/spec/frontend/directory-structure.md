# Directory Structure

> Frontend file layout.

---

## Layout

```
src/
├── app/
│   ├── layout.tsx            # mantineHtmlProps + ColorSchemeScript + MantineProvider（主题入口）
│   ├── globals.css           # 排版与编辑式列表（颜色令牌别名到 Mantine CSS 变量）
│   ├── page.tsx              # redirect("/status")
│   ├── login/page.tsx        # public client page
│   └── (admin)/
│       ├── layout.tsx        # server component: session check + AdminNav
│       ├── status/page.tsx
│       ├── bulletins/page.tsx
│       ├── bulletins/[id]/page.tsx
│       ├── needs/page.tsx
│       ├── channels/page.tsx
│       ├── jev/page.tsx
│       └── push/page.tsx
├── theme.ts                  # Mantine createTheme（primaryColor / defaultRadius / fontFamily）
└── components/
    ├── api-client.ts         # fetch wrapper: x-requested-with, {ok} envelope, 401 -> /login
    ├── api-types.ts          # client-side DTOs + status label maps
    ├── use-api.ts            # useApiResource<T>(path, { refreshMs })
    ├── pagination-model.ts   # 分页纯函数：pageCount / clampPage / pageRange
    ├── status-badge.tsx      # 唯一的「状态 → Mantine Badge 颜色」映射
    ├── ThemeToggle.tsx       # 浅色 / 深色 / 跟随系统（useSyncExternalStore 挂载门控）
    ├── AdminNav.tsx          # nav links + ThemeToggle + logout
    └── ui/                   # presentational primitives (no fetch, no domain state)
        ├── PageHeader.tsx    # h1 + lead + actions
        ├── Section.tsx       # 规则线区块（alt = 浅底强调面板）
        ├── TableScroll.tsx   # accessible horizontal scroll container
        ├── List.tsx          # List / ListItem / Eyebrow（编辑式条目列表）
        ├── Pagination.tsx    # 总数 + 范围 + Mantine Pagination
        └── Feedback.tsx      # loading / success / error / notice（内部用 Mantine Alert）
```

根目录另有 `postcss.config.mjs`（`postcss-preset-mantine`，为自定义 CSS 提供 `rem()`/mixin）。

---

## Rules

- A page under `(admin)/` is a client component unless it only renders static markup.
  The route group's `layout.tsx` is the only server component that touches the database.
- Reusable pieces live in `src/components/`, not in a page file — except a form that is
  deliberately co-located and keyed by the server version (see `JevForm`, `PushForm`,
  `SelectionForm`).
- `src/components/ui/` holds only presentational primitives (typed props in, JSX out). They
  must not fetch, hold domain state, or import `@/lib/**`.
- Never create a second fetch helper; extend `api-client.ts`.
- `src/components/ui/` 里的原语可以包裹 Mantine 组件，但不得暴露 Mantine 类型到页面；
  页面用到的 Mantine 组件直接从 `@mantine/core` 引入。
- 纯逻辑（不返回 JSX）放 `src/components/*.ts`（如 `pagination-model.ts`），便于离线单测。
