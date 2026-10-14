# Quality Guidelines

> Frontend standards enforced by `pnpm lint` / `pnpm typecheck` / `pnpm build`.

---

## Lint rules that shape the code

| Rule | Consequence |
| --- | --- |
| `react-hooks/set-state-in-effect` | Data loading must go through `useApiResource`; config forms must be keyed child components |
| `@next/next/no-location-assign-relative-destination` | Use `window.location.replace("/login")`, not `.href = "/login"` |
| `react-hooks/exhaustive-deps` | Keep `useApiResource`'s dependency array exact |

## Copy conventions

- All user-facing copy is Simplified Chinese.
- Distinguish clearly: 「明确匹配」/「待确认（信息不足）」/「处理失败」/「没有匹配」.
- Label generated text: 「以下为**程序生成的分类说明**（不是模型生成的理由）」.
- State limits honestly: “不代表设备已读”, “不代表券后实付”, “不承诺补齐完整历史”.

## Structure

- Pages fetch and render; components receive typed props from `api-types.ts`.
- No inline `any`, no `as` casts on API responses — `apiGet<T>` is already typed.
- Tables always render an empty-state paragraph instead of an empty `<table>`.
- Long forms get `<fieldset><legend>` for each credential so the 保留/替换/清除 choice is explicit.

## Verification

- `pnpm typecheck` and `pnpm lint` must be clean.
- `pnpm build` must show all `/api/*` routes as dynamic (`ƒ`) and `/` + `/login` as static.
- Manual smoke: unauthenticated `/api/needs` → 401; wrong password → 401; login → masked config
  reads with no plaintext.
