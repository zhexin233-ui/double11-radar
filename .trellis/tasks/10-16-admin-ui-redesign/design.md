# 技术设计 · 编辑式列表 + 分页 + 深色主题（Mantine v9）

> 对应 `prd.md`。本文回答「怎么改、改哪些文件、契约怎么变、风险与验证」。
> 现状审计见 `research/current-ui-inventory.md`。

---

## 0. 前置：必须先读的框架文档

`AGENTS.md` 明确要求：写任何代码前先读本仓库的 Next 文档（`next` 版本与训练数据不同）。本任务至少要读：

- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`（App Router 里第三方 CSS 的导入与顺序）
- `node_modules/next/dist/docs/01-app/02-guides/css-in-js.md`（客户端 Provider + 首屏样式注入的官方口径）
- `node_modules/next/dist/docs/01-app/02-guides/third-party-libraries.md`
- 若新增 `postcss.config.mjs`：`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/` 下的 PostCSS / Lightning CSS 相关页，确认自定义 PostCSS 配置不被 Turbopack 忽略

如果文档揭示与本文冲突的做法，以文档为准并回来更新本文。

---

## 1. 依赖与集成

### 1.1 新增依赖

```bash
pnpm add @mantine/core @mantine/hooks
pnpm add -D postcss postcss-preset-mantine
```

- `@mantine/hooks` 是 `@mantine/core` 的 peer 依赖，必须一起装。
- `postcss-preset-mantine` 官方口径是「非必需但强烈推荐」：它提供 `rem()`/`em()` 函数、`light-dark()` 与
  Mantine mixin，并启用 `postcss-nested`。我们暂时不依赖这些能力，但装上可避免以后写自定义 CSS 时踩坑，
  且不会改变现有纯 CSS 的处理结果。
- 不装 Tailwind、不装图标库（主题切换用文字标签，不用图标依赖）。
- 不装 `@mantine/notifications`（反馈继续走 `Feedback`，不引入第二套提示机制）。

### 1.2 样式入口与顺序（`src/app/layout.tsx`）

```tsx
import "@mantine/core/styles.css";
import "./globals.css";              // 必须在其后：我们的令牌与排版覆盖库的全局样式
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { theme } from "@/theme";

<html lang="zh-CN" {...mantineHtmlProps}>
  <head>
    <ColorSchemeScript defaultColorScheme="auto" />
  </head>
  <body>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      {children}
    </MantineProvider>
  </body>
</html>
```

- `mantineHtmlProps` 负责给 `<html>` 打上 Mantine 需要的属性并处理 hydration 抑制，不要手写这些属性。
- `ColorSchemeScript` 必须在 `<head>` 中先于正文渲染：它在首帧前把 `data-mantine-color-scheme` 与
  `color-scheme` 写到 `<html>`，这是「刷新不闪白屏」的关键。
- `MantineProvider` 只渲染一次（根布局）；`defaultColorScheme="auto"` = 首次访问跟随系统。

### 1.3 主题（新增 `src/theme.ts`）

```ts
import { createTheme } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
  cursorType: "pointer",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
});
```

**为什么 `primaryColor: "blue"` 而不是自定义色阶**：主色只有一个来源更安全。我们的
`--accent` / `--accent-hover` 直接别名到 `--mantine-primary-color-filled(-hover)`，
这样链接、主按钮、`Badge`、`Alert`、`Modal` 的强调色天然一致，也不会出现两套蓝。
编辑式的层级感靠排版（字号 / 字距 / 分割线）实现，不靠颜色堆叠。

---

## 2. 主题机制（深色 / 浅色 / 跟随系统）

### 2.1 深浅切换的实现权在 Mantine

- `useMantineColorScheme()` → `{ colorScheme: 'light'|'dark'|'auto', setColorScheme, clearColorScheme }`
- `useComputedColorScheme('light')` → 解析后的 `'light'|'dark'`（`auto` 时按系统）
- 持久化：Mantine 默认写 `localStorage`（键 `mantine-color-scheme`），`ColorSchemeScript` 负责首帧读取。
- **切换逻辑必须用 `computedColorScheme` 判定当前生效主题**，不能用 `colorScheme`（`auto` 既可能是浅也可能是深，
  官方文档专门把这一点列为「错误的实现」）。

### 2.2 切换控件（新增 `src/components/ThemeToggle.tsx`）

- 形态：`Menu`（`position="bottom-end"`）+ `Button variant="default" size="compact-md"`，
  标签为 `外观：跟随系统 / 浅色 / 深色`，菜单项三项，当前项带 `Check`。
- 不用 `SegmentedControl`：窄屏顶栏已经要横向滚动，三段控件会挤掉导航项。
- 不引入图标库：文字标签足够，且避免新增依赖。
- 无障碍：触发按钮 `aria-label="外观主题"`，菜单项用 `Menu.Item`（自带键盘可达与 `role="menuitem"`）。

### 2.3 hydration 策略（重点）

`ThemeToggle` 的显示值来自客户端存储，SSR 时只能拿到 `defaultColorScheme`。处理顺序：

1. 首选：直接消费 `useMantineColorScheme().colorScheme`。Mantine 的 provider 在 App Router 下与
   `ColorSchemeScript` 配合，官方示例即直接这样用。
2. **必须验证**：`pnpm dev` 打开任意管理页，dev console 不得出现 hydration warning；顶栏标签在首屏
   与刷新后一致。
3. 若出现不匹配，用**挂载门控**修：`useSyncExternalStore(subscribe, () => true, () => false)` 拿
   `mounted`，未挂载时按钮只渲染稳定文本（例如「外观」），挂载后再显示具体值。
   **禁止**用 `useEffect` + `setState`（`react-hooks/set-state-in-effect` 会报错）。

### 2.4 我们自己的 CSS 如何跟随主题

原则：**我们不再自己维护深浅两套颜色**，而是把自有令牌别名到 Mantine 的 CSS 变量
（`@mantine/core/styles.css` 会在 `:root[data-mantine-color-scheme="light|dark"]` 下定义这些变量）。
别名定义一次、在两种主题下都生效，我们的排版 CSS 因此自动跟随主题。

| 自有令牌 | 来源 | 说明 |
| --- | --- | --- |
| `--bg` | `var(--mantine-color-body)` | 页面底色 |
| `--surface` | `var(--mantine-color-body)` | 面板底色（编辑式：与页面同底） |
| `--surface-alt` | `var(--mantine-color-default-hover)` | 浅底强调面板（见下方实现记录） |
| `--surface-hover` | `var(--mantine-color-default-hover)` | 条目/行悬停底 |
| `--text` | `var(--mantine-color-text)` | 正文 |
| `--ink` | `var(--mantine-color-bright)` | 标题（深色下更亮） |
| `--muted` | `var(--mantine-color-dimmed)` | 次级信息 |
| `--hairline` | `color-mix(in srgb, var(--mantine-color-default-border) 60%, transparent)` | 条目发丝线 |
| `--hairline-strong` | `var(--mantine-color-default-border)` | 区块规则线 / 表头线 |
| `--accent` / `--accent-hover` | `var(--mantine-primary-color-filled)` / `…-filled-hover` | 主色 |
| `--r-control` / `--r-panel` | `var(--mantine-radius-md)` / `var(--mantine-radius-lg)` | 圆角 |
| `--font-body` | `var(--mantine-font-family)` | 字体 |

**删除**的令牌：`--danger/--danger-soft/--warning/--warning-soft/--success/--success-soft`、
`--shadow-pop`、`--border`、`--border-strong`、`:{root} color-scheme: light`。
理由：语义色改由 Mantine `Badge`/`Alert` 的 `variant="light"` + `color` 承担（自动适配主题），
阴影交给 `Modal`，`color-scheme` 必须由 Mantine 单一控制（两处定义会打架，深色下原生控件会渲染成浅色）。

> **实现记录（第 2 步）**：
> 1. `--surface-alt` 最终别名为 `var(--mantine-color-default-hover)`（浅色 `gray-0`、深色 `dark-5`），
>    而非本文初稿的 `var(--mantine-color-default)`。原因是后者在浅色下等于 `--mantine-color-body`（纯白），
>    `.section-alt` / `.anchor-nav a` 等「浅底强调面板」会与页面同色而不可见；`default-hover` 在浅深两套下都与页面底色有可辨差异。
> 2. 删除自有语义色令牌的同时，保留了 `.error` / `.success` / `.warning` 文本工具类，
>    但改为直接引用 Mantine 变量（`--mantine-color-error` / `--mantine-color-success` /
>    `--mantine-color-yellow-8` + 深色下 `yellow-4` 覆盖），因为页面表格里仍有错误文本需要着色，
>    这一改动不引入第二套自有色，仍满足「颜色只来自令牌 / Mantine 变量」。

保留自有令牌：`--sp-1..9`（4px 基数的编辑式节奏，Mantine 的 spacing 档位太粗）、
`--fs-body/--fs-meta/--fs-small/--fs-label`、`--tracking-label`、`--content-max`、`--reading-max`、
`--pad-inline`、`--header-pad-block`、`--table-min` 机制。

---

## 3. 视觉系统（`src/app/globals.css` 重写第 4–6 层）

### 3.1 区块：规则线代替卡片

```css
.section {
  background: transparent; border-radius: 0;
  padding: var(--sp-7) 0 0; border-top: 1px solid var(--hairline-strong);
  margin-top: var(--sp-8);
}
.section-alt {
  background: var(--surface-alt); border-top: 0;
  border-radius: var(--r-panel); padding: var(--sp-6); margin-top: var(--sp-6);
}
```

`h1` 收到 `clamp(1.9rem, 3vw, 3rem)`，`--header-pad-block` 64 → 48px。`.page`/`.stack`/`.grid-2`/`.facts`/
`.stats`/`.toolbar` 等布局工具保留（它们不涉及颜色，只吃新令牌）。

### 3.2 条目列表（核心新增）

```css
.eyebrow {                     /* 状态 / 来源 / 时间 小标签行 */
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  font-size: var(--fs-label); letter-spacing: var(--tracking-label);
  color: var(--muted); margin: 0 0 var(--sp-2);
}
.eyebrow .sep::before { content: "·"; }      /* 分隔点由 CSS 生成，读屏不读它 */

.list { list-style: none; margin: 0; padding: 0; }
.list-item {
  border-top: 1px solid var(--hairline);
  padding: var(--sp-5) var(--sp-4);
  margin-inline: calc(var(--sp-4) * -1);     /* 悬停底色铺满，文字仍与容器对齐 */
}
.list-item:first-child { border-top: 0; }
.list-item:hover { background: var(--surface-hover); }
.list-body { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: var(--sp-4); align-items: start; }
.list-title { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
a.list-title:hover { text-decoration: underline; }
.list-meta { display: flex; flex-wrap: wrap; gap: var(--sp-4); color: var(--muted); font-size: var(--fs-meta); margin-top: var(--sp-2); }
.list-trailing { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; justify-content: flex-end; }
@media (max-width: 640px) { .list-body { grid-template-columns: minmax(0, 1fr); } }
```

### 3.3 表格：真表格数据仍用 `table`

表头小号字距标签 + `--hairline-strong` 底线；单元格 `--hairline` 分隔；`tbody tr:hover` 底色。
`.table-scroll` / `--table-min` 机制不动。**不使用 Mantine `Table`**：它的行高/边框/字体变量会与编辑式
表格排版冲突，而原生 `table` 已被 `TableScroll` 处理好横向滚动与 a11y。

### 3.4 反馈

`.feedback` / `.notice` 的**自有颜色定义全部删除**：`Feedback` 组件内部换成 Mantine `Alert`
（`variant="light"`，`error→red`、`success→green`、`loading/notice→gray`）+ `Loader`，
`role="alert"` / `role="status" aria-live="polite"` 的契约原样保留，组件对外的 props 完全不变。

### 3.5 徽标

`src/components/ui/*` 之外新增 `src/components/status-badge.tsx`：

```tsx
const STATUS_COLORS: Record<string, string> = {
  matched: "green", succeeded: "green",
  uncertain: "yellow", pending: "yellow",
  failed: "red", disabled: "red",
  baseline: "gray", not_matched: "gray", sending: "gray",
};
export function StatusBadge(props: { status: string; children: ReactNode }) {
  return <Badge variant="light" color={STATUS_COLORS[props.status] ?? "gray"}>{props.children}</Badge>;
}
```

`children` 仍然由页面传 `STATUS_LABELS[...]` / `EVALUATION_LABELS[...]` / `DELIVERY_LABELS[...]`，
**颜色映射只有这一处，文案映射仍只有 `api-types.ts` 一处**。`.badge` 的 CSS 与语义色类全部删除。

### 3.6 按钮

`.btn` / `.btn-primary` / `.btn-ghost` / `.primary` / `.ghost` / `.btn-danger` / `.btn-quiet` 全部删除，
改用 Mantine `Button`：

- 页面级主操作：`variant="filled"` `size="md"`
- 次要操作（刷新、测试发送、取消）：`variant="default"` `size="sm"`
- 条目内联操作：`variant="subtle" color="gray" size="sm"`；危险操作 `variant="subtle" color="red"`
- 忙态：`loading={busy}` 替代「保存中…」文案切换（spinner 表达状态，标签保持稳定）

`group="apart"`/`flex` 布局仍用 `.toolbar` / `.row` 类，不用 Mantine `Group`，避免两套间距体系。

---

## 4. 组件设计

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `src/components/ui/List.tsx`（新） | 展示原语 | `List`（`<ul class="list">`）、`ListItem`（`<li class="list-item">`）、`Eyebrow`（`items` 依次渲染 + `.sep` 分隔）。只输出结构与类名，不接收 DTO |
| `src/components/ui/Pagination.tsx`（新） | 展示原语 | 左侧「共 N {unit} · 第 a–b {unit}」+ 可选 `note`，右侧 Mantine `Pagination`；`total === 0` 返回 `null`；不 fetch、不改 state |
| `src/components/pagination-model.ts`（新） | 纯函数 | `pageCount(total, pageSize)`、`clampPage(page, total, pageSize)`、`pageRange(page, pageSize, total)` |
| `src/components/status-badge.tsx`（新） | 展示 | 状态 → Mantine `Badge` 颜色（见 §3.5） |
| `src/components/ThemeToggle.tsx`（新） | 交互 | 主题三态切换（见 §2.2） |
| `src/components/ui/Feedback.tsx`（改内部） | 展示 | 保留 props，内部换 `Alert` + `Loader` |
| `src/components/ui/Section.tsx` / `PageHeader.tsx` / `TableScroll.tsx`（不变） | 展示 | 只吃新 CSS |
| `src/components/AdminNav.tsx`（小改） | 交互 | 顶栏加入 `ThemeToggle`；`scrollTo` 逻辑**不动**（spec 有 gotcha） |

`Pagination` 包裹 Mantine `Pagination` 而不是直接用库组件的理由：四处页面都需要「总数 + 范围 + 页控件」
这套统一文案，把范围计算与 `clampPage` 兜底收在一处，避免又出现两套手写分页。

**越界收敛不用 `useEffect`**：页面用 `clampPage(page, total, pageSize)` 在渲染期派生 `safePage`，
再由 `safePage` 算出 `offset` 拼进 `useApiResource` 的 `path`。total 缩减 → `path` 变化 → 自动重新请求，
同时删掉 `bulletins/page.tsx` 现有的 `eslint-disable react-hooks/set-state-in-effect`。

---

## 5. 服务端分页设计

### 5.1 共用查询解析 `src/lib/http/query.ts`（新增）

```ts
export function parseIntegerParam(raw: string | null, fallback: number): number
export function clampLimit(value: number, max: number): number
export function parsePageQuery(
  params: URLSearchParams,
  options: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number }
```

规则与现状一致：`null` / 空串 → 默认值；非整数（`"abc"`、`"2.5"`）→ 默认值；负数 offset → 0；
limit 超上限 → 夹取。**非法输入回退，绝不 500。**

复用改造（行为不变，仅消除重复）：
- `src/lib/service/bulletins.ts`：`parseBulletinListQuery` 内部改用共用 helper，对外行为不变
  （默认 50、上限 200、status 校验、`baseline: false` 全部保持）。
- `src/app/api/settings/jev/usage/route.ts`：改用 `parsePageQuery`（默认 20）。

### 5.2 仓库层（新增函数，不改既有签名）

`src/lib/db/repos/needs.ts`：

```ts
export function listNeedsPage(db, query: { limit: number; offset: number }): { items: Need[]; total: number }
```

`ORDER BY created_at ASC, id ASC`（追加唯一并列键，否则分页会重复/漏项）；`items` 与 `total` 在同一个
只读事务内读取（与既有 `listBulletinDetails` 一致）。

`src/lib/db/repos/channels.ts`：

```ts
export function listChannelsPage(db, query: { limit: number; offset: number }): { items: ChannelState[]; total: number }
```

`ORDER BY origin ASC, name ASC, id ASC`；`total` 同事务计数。
`listChannels` / `listDueChannels` 及其调用点（`/api/status`、`/api/channels/refresh`、
`/api/channels/selection`、worker）**全部不动**。

### 5.3 常量

- 服务端 `src/lib/domain/constants.ts`：`NEEDS_LIST_DEFAULT_LIMIT = 10`、`NEEDS_LIST_MAX_LIMIT = 100`、
  `CHANNELS_LIST_DEFAULT_LIMIT = 20`、`CHANNELS_LIST_MAX_LIMIT = 200`。
- 客户端 `src/components/api-types.ts`（不能引 `@/lib`）：`NEEDS_PAGE_SIZE = 10`、
  `CHANNELS_PAGE_SIZE = 20`、`interface PagedItems<T> { items: T[]; total: number }`。

### 5.4 路由契约变化

| 路由 | 变化 |
| --- | --- |
| `GET /api/needs?limit&offset` | 响应新增 `total: number`；`items` 变为一页（原为全量） |
| `GET /api/channels?limit&offset` | `channels` 变为一页；**不新增字段**，分页总数复用既有 `stats.total`（两者都是「全部频道数」，`listChannels` 本就返回全部）。`selection` / `stats` 不变 |
| `GET /api/bulletins` | 不变（已有 limit/offset/total） |
| `GET /api/settings/jev/usage` | 不变（已有 limit/offset，`recent.total`） |
| 其余 `/api/*` | 不变 |

**为什么 channels 不自带 `total`**：`stats.total` 就是这个数，重复字段会漂移。若将来列表需要过滤，
再引入显式分页字段并同步更新本文。

---

## 6. 分页边界：谁分页、谁不分页

| 列表 | 决定 | 理由 |
| --- | --- | --- |
| 线报记录 | 服务端 50/页 | 无限增长，已有实现 |
| 需求清单 | **新增**服务端 10/页 | 无限增长；行高较大，10 条可读 |
| 采集频道 | **新增**服务端 20/页 | 官方能力清单可达上百条 |
| Jev 最近调用 | 服务端 20/页 | 已有实现 |
| Jev 按 Key 汇总 | 不分页 | 基数 = Key 数量（个位–十位），本身是全量汇总 |
| Jev API 密钥列表 | 不分页 | 基数 = Key 池规模，受运营约束 |
| 线报详情 · 逐需求判断 | 不分页 | 基数 = 启用需求数 × 1 |
| 线报详情 · 投递状态 | 不分页 | 基数 = 渠道数（当前 2） |
| 运行状态 · 频道错误 | 不分页 | 诊断快照；Section description 已给出 `stats.failing` 总数，UI 需写明 |
| 运行状态 · 最近失败任务 | 不分页 | 服务端硬限 `listRecentFailedJobs(db, 10)`；UI 需写明「最多显示最近 10 条」 |

### 采集频道分页的勾选语义

- `selection.customIds` 来自服务端设置，涵盖**所有页**；分页只影响展示。
- 模式选择处显示 `自定义选择（已选 N 个，含其它页）`，让用户知道隐藏页仍有选择。
- `mode === "all"` 时勾选态由 `channel.selected && channel.available` 推导，与分页无关。
- 保存仍提交**完整** `customIds`（`SelectionForm` 在完整数组上增删），不得改成「只提交本页选中项」。

---

## 7. 逐页改造映射

| 页面 | 结构改造 | Mantine 替换 | 分页 |
| --- | --- | --- | --- |
| `login/page.tsx` | `.auth-card` 去阴影改发丝边；标题阶梯 | `PasswordInput`、`Button`、`Feedback` | 无 |
| `status/page.tsx` | 健康摘要 `Section alt`；统计数字行；facts；两表加「共 N 个 / 最多 10 条」说明 | `StatusBadge`、`Button` | 无（见 §6） |
| `bulletins/page.tsx` | 表格 → `List`/`ListItem`：Eyebrow（状态徽标 · 来源 · 时间）、`.list-title` 链接、`.list-meta`（价格 / 命中需求 / 处理来源）、`.list-trailing`「查看 →」 | `Select`（状态筛选）、`Switch`（自动刷新）、`Button`、`Pagination` | 换 `Pagination`；删掉收敛 `useEffect`，改用 `clampPage` |
| `bulletins/[id]/page.tsx` | header 重排；facts 与两表走新样式；`pre` 正文行高与宽度 | `StatusBadge`、`Button`、`Feedback` | 无 |
| `needs/page.tsx` | 新增表单 `Section`；表格 → `List`（Eyebrow = 启用徽标 · v版本 · 更新时间；名称/备注保留 `key` + `onBlur`；行尾操作） | `TextInput`、`Switch`、`Modal`（删除确认）、`Button`、`Pagination` | **新增** 10/页 |
| `channels/page.tsx` | 模式单选 + 「已选 N 个（含其它页）」；表格保留但走新样式 | `Radio`、`Checkbox`、`Button`、`Pagination` | **新增** 20/页；空态判定改用 `stats.total` |
| `jev/page.tsx` | 配置区/密钥区/用量的 Section 重排 | `TextInput`、`NumberInput`、`Textarea`、`Radio`、`Fieldset`、`StatusBadge`、`Button`、`Pagination` | 最近调用换 `Pagination`（`unit="次调用"`）+ `clampPage` |
| `push/page.tsx` | 两个凭证 `fieldset` 走新样式；keyed form 不变 | `Switch`、`Radio`、`TextInput`、`PasswordInput`、`Fieldset`、`Button` | 无 |

**步进顺序**（影响面从小到大）：`globals.css` + 主题骨架 → 新组件 → 服务端分页 → login →
status → bulletins → bulletins/[id] → needs → channels → push → jev。

---

## 8. 兼容性与风险

| 风险 | 处理 |
| --- | --- |
| 引入库后与既有 spec「no UI kit」冲突 | 收尾阶段同步更新 `.trellis/spec/frontend/index.md`、`component-guidelines.md`、`directory-structure.md`、`quality-guidelines.md`（见 `implement.md` 第 7 步） |
| 首屏闪白 / hydration 警告（主题） | `ColorSchemeScript` 在 `<head>`；`mantineHtmlProps`；`ThemeToggle` 按 §2.3 的验证与门控方案；以 dev console 无警告为验收项 |
| 自定义 `color-scheme` 与 Mantine 打架 | 删除 `:root { color-scheme: light }`，只由 Mantine 控制；深色下检查原生控件（滚动条、`input`）表现 |
| 两套颜色来源（自有令牌 vs Mantine 变量） | 自有令牌一律别名到 Mantine 变量（§2.4）；`grep -nE "#[0-9a-fA-F]{3,8}" src/app/globals.css` 应为空（`--table-min` 等非颜色不受影响） |
| Mantine 组件与自有间距体系混杂 | 只用库的控件类组件；布局继续用 `.row`/`.stack`/`.toolbar`/`.grid-2`，不混用 `Group`/`Stack` 的 spacing |
| `Section` 视觉变化一次性影响所有页面 | 先落 CSS + 主题骨架并人工过一遍；类名与结构不变，便于单文件回滚 |
| 分页排序不稳定导致跨页重复/漏项 | 排序追加唯一键 `id`，单测覆盖并列键场景 |
| `/api/channels` 返回一页后，若某处仍假设全量会静默丢数据 | 已审计：`status`/`refresh`/`selection`/worker 全用 `listChannels`（全量），只有 channels 页改分页接口 |
| 频道分页让隐藏页选择「看起来丢了」 | 显示「已选 N 个（含其它页）」；保存提交完整 `customIds` |
| needs 行内编辑与分页交互冲突 | 保留 `key={id:version:field}` + `onBlur` 提交（spec 既有约定）；翻页前输入框自然失焦提交 |
| `window.confirm` → `Modal` 的行为变化 | 文案与后果不变（「历史判断记录会保留需求快照」），只是换成可键盘操作的对话框 |
| 忙态文案从「保存中…」变为 loading spinner | 属交互表达变化，不是语义文案变化；`Feedback` 与状态标签类文案一律不动 |
| `package.json` / `pnpm-lock.yaml` 混入无关的 `undici` 未提交改动 | 装依赖前后 `git diff` 对照；提交时 `git add -p` 只取 Mantine 相关行（见 `implement.md` 第 7 步） |

---

## 9. 测试计划

**新增单测**

- `tests/components/pagination-model.test.ts`：`pageCount`（total=0 / 整除 / 有余数）、`clampPage`
  （越界夹取、total 缩减）、`pageRange`（首页 / 末页 / 空集 / 与 offset 一致）。
- `tests/http/query.test.ts`：`parseIntegerParam`（`null`/`""`/`"abc"`/`"2.5"`/`"-5"`）、`clampLimit`、
  `parsePageQuery`（默认值、负数 offset、limit 夹上限）。
- `tests/db/repos.test.ts`（扩展）：`listNeedsPage` / `listChannelsPage` 的 `total`、offset 窗口、
  `offset >= total` 返回空、并列键（同名）跨页不重不漏。

**回归**

- `tests/service/bulletins.test.ts` 必须仍通过（`parseBulletinListQuery` 行为不变）。

**命令**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build        # /api/* 仍是 dynamic（ƒ），/ 与 /login 静态
grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css    # 期望无输出
```

**手工冒烟**

1. 未登录 `curl -i /api/needs` → 401；登录后 `/api/needs?limit=abc&offset=-3` → 200 且用默认页大小。
2. `/bulletins` 翻到末页 → 页控件禁用、范围文案正确；切换状态筛选后回到第 1 页。
3. `/needs` 第 2 页改名称失焦保存后仍停在第 2 页；删除最后一条 → 页数收缩且不停空白页；删除走 Modal。
4. `/channels` 第 1 页勾选 → 第 2 页勾选 → 保存 → 计数显示「已选 N 个（含其它页）」→ 回第 1 页选择仍在。
5. `/jev` 最近调用翻页；金额文案不变（未知不显示 $0.00）；三模式单选与正则文本域正常。
6. 主题：首次访问（清 localStorage）跟随系统；手动切浅色/深色/跟随系统立即生效；刷新不闪白屏；dev console 无 hydration 警告。
7. **每个页面在浅色与深色下各看一遍**：对比度可读、状态色可区分、表格发丝线与分割线可见。
8. 375px 宽度逐页检查：无整页横向溢出（宽表自身滚动除外），顶栏导航与主题切换可用。
9. `/bulletins/[id]` 打开 filtered 记录 → 仍显示 `screeningReason`，无虚构概率。
10. `/push` 凭证三态（保留/替换/清除）正确；空输入仍表示「保留」。

---

## 10. 回滚

- 提交拆分（按序，可整段回退）：① 依赖 + 主题骨架 + `globals.css`；② 新组件与服务端分页；③ 逐页改造。
- 回滚 = `git revert <sha>`；依赖回退 = `pnpm remove @mantine/core @mantine/hooks && pnpm remove -D postcss postcss-preset-mantine`，
  并删除 `postcss.config.mjs`、`src/theme.ts` 与 `<MantineProvider>`。
- 无 schema 变更、无迁移；`/api/needs` 新增 `total` 为向后兼容加法，回滚后旧客户端行为不变。

---

## 11. 实现记录（与本文的偏差 + 实施期发现，2026-10-16）

实施后回填，供 check 代理与后续任务对照。

### 11.1 已接受的偏差

| 位置 | 本文原写法 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 分页越界收敛 | 纯 `clampPage` 派生 `offset` | 渲染期「比较后修正 state」+ `clampPage` 兜底 | `ApiResourceController` 在 path 变化时清空 `data`；纯派生会让 offset 在 `page` 与 clamp 结果之间抖动成请求循环（实测 2 次请求后稳定） |
| 采集频道选择态 | keyed `SelectionForm` | `mode` / `customIds` 上提到 `ChannelsPage`，服务端 selection 变化时同步 | 分页切换会卸载 keyed 子组件，未保存的跨页勾选会丢 |
| `StatusBadge` 根元素 | 未指定 | `component="span"` | `Badge` 默认 `div`，放进 `Eyebrow`（`p`）会触发 hydration 非法嵌套报错 |
| `jev` 表单宽度 | 未指定 | 新增 `.form-narrow`（680px）应用于 `JevForm` | 宽屏下单列输入框被拉到 1100px，可读性差 |
| `--surface-alt` | `var(--mantine-color-default)` | `var(--mantine-color-default-hover)` | `--mantine-color-default` 在浅色下等于白色，浅底面板不可见 |
| `.error/.success/.warning` 文本类 | 计划随语义色令牌一并删除 | 保留，但改引 Mantine 变量 | 表格错误文本仍需要着色；保留类比引入第二套自有色更安全 |
| `/status` 投递状态标签 | 未指定 | 新增 `deliveryLabel()`，聚合计数走中文标签 | spec 要求状态一律走 label 映射；原实现直接渲染英文原始状态 |
| `DryRunPanel.tsx` | 未在逐页清单内 | 一并迁移到 Mantine 组件 | 它渲染在 `/jev` 内且依赖已删除的 `.btn*` / `.badge*` / `.notice` |

### 11.2 实施期发现并修掉的视觉缺陷（自测截图后修正）

1. **间距叠加**：`.page { gap: 48px }` + `.section { margin-top: 48px }` + `.page-header` 下内边距 32px
   叠成了 ~150px 的空白。修正：`--header-pad-block` 48→40、`.page-header` 下内边距归零、
   `.page` gap 48→32、`.section` / `.section-alt` 的 `margin-top` 归零。
2. **深色下表头对比不足**：`thead th` 用 `--muted` 在 12px + 字距下几乎不可读。修正：改用 `--text`，
   层级靠字号与字距拉开。
3. **需求清单行被两个表单框包住**：改为 `variant="unstyled"` + `input.list-title` / `input.list-note`，
   悬停/聚焦才出现底线；焦点可见性仍由全局 `:focus-visible` outline 负责。
4. **行内状态重复**：eyebrow 的「已启用」徽标与 Switch 的 label 重复。修正：去掉 Switch 的可见 label，
   改 `aria-label`，徽标保留为唯一状态显示。
5. **`status/page.tsx` 引用了已删除的 `--danger` 令牌**（第 2 步的漏网回归）。修正：改 `--mantine-color-error`。

### 11.3 验证证据（本人复核，非子代理自述）

- `pnpm lint` / `pnpm typecheck` / `pnpm test`（35 文件 260 用例）/ `pnpm build` 全绿；
  build 中 `/api/*` 全为 `ƒ`，`/login` 为 `○`。
- `grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 无输出。
- 主题端到端（headless Chrome + CDP，`:9333`，`Emulation.setEmulatedMedia` 模拟系统偏好）：
  初始跟随系统 → 菜单三项（跟随系统✓/浅色/深色）→ 点「深色」立即生效并写入 `localStorage=mantine-color-scheme-value: dark`
  → 刷新后仍为 dark → 选「跟随系统」时随模拟系统变为 dark；**全程 console 无 error/warning（含 hydration）**。
- 浅色与深色各截图走查 8 个页面（`/tmp/shots/out3/*.png`），确认无整页横向溢出
  （`scrollWidth 1425 ≤ innerWidth 1440`）。
- 分页与跨页勾选由子代理用 CDP 实测：`/bulletins` 翻到第 2 页「第 51–55 条」、
  `/channels` 跨页选中显示「已选 2 个，含其它页」、`/jev` 翻页「第 21–40」。
- 未做：真实推送/试判的网络交互（`/api/settings/notify/test`、`/jev/dry-run`）未点击验证，
  逻辑未改，只改了渲染与忙态结构。
