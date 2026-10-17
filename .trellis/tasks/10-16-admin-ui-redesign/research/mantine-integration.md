# 研究：Mantine v9 + Next 16 App Router 集成契约

来源：Mantine 官方文档（`https://mantine.dev/guides/next/`、`/theming/color-schemes/`、
`/theming/mantine-provider/`、`/styles/postcss-preset/`），抓取时间 2026-10-16。
本仓库 Next 版本以 `node_modules/next/dist/docs/` 为准（AGENTS.md 要求）。

---

## 1. App Router 官方接线（已核实）

```tsx
// Import styles of packages that you've installed.
// All packages except `@mantine/hooks` require styles imports
import '@mantine/core/styles.css';

import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from '@mantine/core';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript />
      </head>
      <body>
        <MantineProvider>{children}</MantineProvider>
      </body>
    </html>
  );
}
```

- `mantineHtmlProps` 是必须 spread 到 `<html>` 上的属性包（官方示例如此，包含 hydration 抑制与主题属性）。
- `ColorSchemeScript` 放在 `<head>`，默认 `defaultColorScheme="light"`；我们要 `"auto"`。
- 官方模板同时配置了 PostCSS 与 `ColorSchemeScript`；**没有提供 App Router 专用的主题样式注册步骤**
  （Mantine 用 CSS 变量而非运行时 CSS-in-JS，因此不需要 `useServerInsertedHTML` 风格注册）。

## 2. 颜色方案 API（已核实）

```ts
const { colorScheme, setColorScheme, toggleColorScheme, clearColorScheme } = useMantineColorScheme();
// colorScheme: 'light' | 'dark' | 'auto'
// setColorScheme: (value: 'light' | 'dark' | 'auto') => void
```

- `useComputedColorScheme('light')` 返回解析后的 `'light' | 'dark'`（`auto` 时读系统偏好）。
- 官方明确把「用 `colorScheme` 判断再切换」列为**错误实现**，因为 `auto` 可能既是浅也是深；
  正确做法是用 `computedColorScheme`：

```ts
const computedColorScheme = useComputedColorScheme('light');
const toggle = () => setColorScheme(computedColorScheme === 'dark' ? 'light' : 'dark');
```

**本任务不是二态 toggle，而是三态选择（浅/深/跟随）**，所以直接 `setColorScheme('auto' | 'light' | 'dark')`，
展示值用 `colorScheme`，需要判断「当前实际生效的颜色」时才用 `computedColorScheme`。

- 属性：`MantineProvider` 挂载后会在 `<html>` 上设置 `data-mantine-color-scheme="light|dark"`
  （默认根元素 `document.documentElement`，可用 `getRootElement` 改）。所有组件样式与
  「我们自己的主题别名」都依赖这个属性。
- 持久化：默认用 `window.localStorage`（键 `mantine-color-scheme`），可用
  `localStorageColorSchemeManager({ key })` 换键。`ColorSchemeScript` 负责首帧读取以避免闪烁。
- `forceColorScheme` 会禁用切换，本任务不用。

## 3. PostCSS preset（已核实）

- 官方口径：`postcss-preset-mantine` **不是必需的，但强烈推荐**；它包含 `postcss-nested`、
  带 Mantine mixin 的 `postcss-mixins`、以及自定义 `em`/`rem` 函数插件。
- 装它不会改变现有纯 CSS 的处理结果（现有 `globals.css` 没用嵌套/mixin/rem 函数）。
- 结论：装上，减少以后写自定义 CSS 的摩擦；`postcss.config.mjs` 由实现步骤新增。

## 4. 版本与兼容性（本机核实）

| 包 | 最新版本（2026-10-16 查询） | 备注 |
| --- | --- | --- |
| `@mantine/core` | 9.7.2 | 需与 `@mantine/hooks` 同版本 |
| `@mantine/hooks` | 9.7.2 | `@mantine/core` 的 peer 依赖，必须一起装 |
| `postcss` | 8.x | dev |
| `postcss-preset-mantine` | 1.x | dev |

本仓库：`next@^16.4.0`、`react@^19.3.0`、`node@22.23.2`、`pnpm@10.13.1`。

## 5. 本仓库必须先读的 Next 16 文档

- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
- `node_modules/next/dist/docs/01-app/02-guides/css-in-js.md`
- `node_modules/next/dist/docs/01-app/02-guides/third-party-libraries.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/`（PostCSS / Lightning CSS）

## 6. 待实现阶段验证的未知项

1. `MantineProvider` 在 App Router SSR 首帧下，`useMantineColorScheme().colorScheme` 的返回值
   在服务端与客户端首帧是否一致（决定 `ThemeToggle` 是否出现 hydration 警告）。
   若不一致 → 用 `useSyncExternalStore` 做挂载门控（**不得**用 `useEffect` + `setState`，lint 会报
   `react-hooks/set-state-in-effect`）。
2. `@mantine/core/styles.css` 里 `body` / `color-scheme` 的全局声明具体是什么，
   以确认我们删除 `:root { color-scheme: light }` 后深色下原生控件表现正确。
3. `--mantine-color-bright` 在浅色/深色下的取值是否适合做标题色（`--ink`）；若不合适，
   改用 `--mantine-color-text` 并靠字重区分层级（仍需更新 `design.md`）。
