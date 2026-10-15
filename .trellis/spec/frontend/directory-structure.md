# Directory Structure

> Frontend file layout.

---

## Layout

```
src/
├── app/
│   ├── layout.tsx            # <html lang="zh-CN">, imports globals.css
│   ├── globals.css           # all styling (tokens, cards, tables, badges)
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
└── components/
    ├── api-client.ts         # fetch wrapper: x-requested-with, {ok} envelope, 401 -> /login
    ├── api-types.ts          # client-side DTOs + status label maps
    ├── use-api.ts            # useApiResource<T>(path, { refreshMs })
    ├── AdminNav.tsx          # nav links + logout
    └── ui/                   # presentational primitives (no fetch, no domain state)
        ├── PageHeader.tsx    # h1 + lead + actions
        ├── Section.tsx       # titled panel
        ├── TableScroll.tsx   # accessible horizontal scroll container
        └── Feedback.tsx      # loading / success / error / notice
```

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
