# Quality Guidelines

> Frontend standards enforced by `pnpm lint` / `pnpm typecheck` / `pnpm build`.

---

## Lint rules that shape the code

| Rule | Consequence |
| --- | --- |
| `react-hooks/set-state-in-effect` | Data loading must go through `useApiResource`; config forms must be keyed child components; 分页越界收敛用「渲染期比较后修正 state」（见 `component-guidelines.md`） |
| `@next/next/no-location-assign-relative-destination` | Use `window.location.replace("/login")`, not `.href = "/login"` |
| `react-hooks/exhaustive-deps` | Keep `useApiResource`'s dependency array exact |
| `react-hooks/set-state-in-render` | 只允许「与另一个 state/props 比较后修正」这种模式，且修正条件必须随后不再成立；不要用它做普通派生 |

## 主题（浅色 / 深色 / 跟随系统）

主题由 Mantine 管理，页面不自己存主题：

- 根布局用 `mantineHtmlProps` + `<ColorSchemeScript defaultColorScheme="auto">` + `<MantineProvider>`；
  三者缺一就会出现首屏闪白或 hydration 不匹配。
- 切换入口是 `ThemeToggle`（三态）。需要判断「当前实际生效的颜色」时用 `useComputedColorScheme`，
  不要用 `colorScheme`（`auto` 既可能是浅也可能是深）。
- **禁止硬编码颜色**：`globals.css` 里只能出现令牌或 Mantine 变量；页面里只能用令牌、
  Mantine `color` prop，或 `.error` / `.success` / `.warning` / `.muted` 这类已有语义类。
  校验：`grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 必须无输出。
- `color-scheme` 只由 Mantine 声明，不要在 `:root` 里重复声明（会让深色下原生控件发白）。
- 深色主题下必须检查：表格表头对比度（`thead th` 用正文色而不是 `--muted`）、发丝线可见、
  状态语义色仍可区分。每个改动过的页面都要在两种主题下各看一遍。
- 挂载门控（首帧不能确定的客户端值）用 `useSyncExternalStore`，不要用 `useEffect` + `setState`。

## Example: the 401 redirect rule

```ts
// src/components/api-client.ts
if (response.status === 401 && typeof window !== "undefined") {
  // 会话过期时回到登录页；用 replace 避免在历史记录里留下受保护页面。
  window.location.replace("/login");
}
```

## Copy conventions

- All user-facing copy is Simplified Chinese.
- Distinguish clearly: 「明确匹配」/「待确认（信息不足）」/「处理失败」/「没有匹配」.
- Label generated text: 「以下为**程序生成的分类说明**（不是模型生成的理由）」.
- State limits honestly: “不代表设备已读”, “不代表券后实付”, “不承诺补齐完整历史”.

## Structure

- Pages fetch and render; components receive typed props from `api-types.ts`.
- No inline `any`, no `as` casts on API responses — `apiGet<T>` is already typed.
- Tables always render an empty-state paragraph instead of an empty `<table>`, and are wrapped
  in `TableScroll` with a `minTableWidth` so wide tables scroll locally.
- Long forms get `<fieldset><legend>` for each credential so the 保留/替换/清除 choice is explicit.
- 单列长表单加 `.form-narrow`（`--form-max: 680px`），不要让输入框在宽屏上拉满上千像素。
- 列表要么有分页（`Pagination` + `*_PAGE_SIZE`），要么在 PRD/design 里写明「为什么不分页」（例如基数有界、
  服务端已硬限条数）；后一种情况必须在 UI 上把条数上限说清楚。
- Admin pages wrap content in `.page` and compose `PageHeader` / `Section`; the public login page
  uses `.auth-main` + `.auth-card`. `globals.css` deliberately does **not** set a width on a bare
  `main` — always use an explicit container class (`admin-main` / `auth-main`).
- Feedback kind must match the outcome: `error` (role=alert) for failures, `success` for confirmed
  saves, `notice` for mixed/neutral results. Never render a failure inside a success style.
- Every page renders exactly one `h1` (`PageHeader`, or a hand-rolled header on the detail page).

## Verification

- `pnpm typecheck` and `pnpm lint` must be clean.
- `pnpm build` must show all `/api/*` routes as dynamic (`ƒ`) and `/` + `/login` as static.
- `grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 无输出。
- 手工冒烟：未登录 `/api/needs` → 401；错密码 → 401；登录 → 掩码配置读取不含明文；
  每个改动的页面在浅色与深色下各看一遍；dev console 无 hydration 警告。
