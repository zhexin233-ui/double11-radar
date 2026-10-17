# 执行计划 · 编辑式列表 + 分页 + 深色主题（Mantine v9）

> 依据 `prd.md` + `design.md`。按序执行，每步末尾必须跑该步的验证命令；失败则停在该步修复，不往下推。
> 目标分支：`main`。

---

## 0. 基线与文档前置（一次）

- [ ] **读 Next 16 本地文档**（`AGENTS.md` 硬性要求，版本与训练数据不同）：
      - `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
      - `node_modules/next/dist/docs/01-app/02-guides/css-in-js.md`
      - `node_modules/next/dist/docs/01-app/02-guides/third-party-libraries.md`
      - 自定义 PostCSS 相关页（引入 `postcss.config.mjs` 前）
      与 `design.md` 冲突处以文档为准，并回来更新 `design.md`。
- [ ] `pnpm lint && pnpm typecheck && pnpm test` 记录改动前基线（必须全绿；不绿则记录为已知问题）。
- [ ] `git status` + `git diff --stat` 记录与本任务无关的既有改动：
      `.dockerignore`、`Dockerfile`、`README.md`、`next.config.ts`、`package.json`、`pnpm-lock.yaml`、
      `src/lib/env.ts`、`src/lib/jev/client.ts`、`AGENTS.md`、未跟踪的 `jevapikey`。
      **`package.json` / `pnpm-lock.yaml` 里已有 `undici` 改动，装 Mantine 前先记下当前 diff 内容，
      以便提交时拆分。`jevapikey` 绝不提交。**

---

## 1. 依赖与主题骨架

- [ ] `pnpm add @mantine/core @mantine/hooks`；`pnpm add -D postcss postcss-preset-mantine`。
- [ ] 新增 `postcss.config.mjs`（`postcss-preset-mantine` + `postcss-simple-vars` 视 preset 要求）。
- [ ] 新增 `src/theme.ts`：`createTheme({ primaryColor: "blue", defaultRadius: "md", cursorType: "pointer", fontFamily })`。
- [ ] `src/app/layout.tsx`：`import "@mantine/core/styles.css"` **先于** `./globals.css`；
      `<html lang="zh-CN" {...mantineHtmlProps}>`；`<head><ColorSchemeScript defaultColorScheme="auto" /></head>`；
      `<MantineProvider theme={theme} defaultColorScheme="auto">`。
- [ ] 新增 `src/components/ThemeToggle.tsx`：`Menu` + `Button variant="default" size="compact-md"`，
      标签 `外观：跟随系统 / 浅色 / 深色`，菜单项带当前态标记；`aria-label="外观主题"`。
- [ ] `src/components/AdminNav.tsx`：顶栏加入 `ThemeToggle`（放在退出登录旁）；**不改** `scrollTo` 逻辑。

验证：

```bash
pnpm dev   # 打开 /status：切主题立即生效；刷新浏览器不闪白屏；dev console 无 hydration 警告
```

**评审点 A（主题机制）**：确认深/浅切换、持久化、无闪烁、无 hydration 警告四项都成立后再继续。
不成立则按 `design.md` §2.3 的挂载门控方案（`useSyncExternalStore`，禁用 `setState in effect`）修复。

---

## 2. 视觉系统（`src/app/globals.css`）

- [ ] 令牌改为别名：`--bg/--surface/--surface-alt/--surface-hover/--text/--ink/--muted/--hairline/--hairline-strong/
      --accent/--accent-hover/--r-control/--r-panel/--font-body` → Mantine CSS 变量（见 `design.md` §2.4）。
- [ ] **删除**：`--danger*`、`--warning*`、`--success*`、`--shadow-pop`、`--border`、`--border-strong`、
      `:root { color-scheme: light }`（`color-scheme` 只能由 Mantine 控制）。
- [ ] 保留自有：`--sp-1..9`、`--fs-*`、`--tracking-label`、`--content-max`、`--reading-max`、`--pad-inline`、
      `--header-pad-block`、`--table-min` 机制。
- [ ] `.section` 改规则线；`.section-alt` 改浅底面板；`h1` 收到 `clamp(1.9rem, 3vw, 3rem)`；
      `--header-pad-block` 64 → 48。
- [ ] 新增 `.eyebrow`（含 `.sep::before { content: "·" }`）、`.list`/`.list-item`/`.list-body`/`.list-title`/
      `.list-meta`/`.list-trailing` + ≤640px 竖排。
- [ ] 表格改编辑式（表头小字距 + `--hairline-strong` 底线、单元格 `--hairline`、`tbody tr:hover` 底色）。
- [ ] 新增 `.pagination` 相关类（`--pagination-*` 或直接使用；等宽数字）。
- [ ] 删除 `.feed/feedback/notice` 的颜色定义、`.badge*` 语义色、全部 `.btn*` / `.primary` / `.ghost` / `.card` 颜色定义。
- [ ] 保留 `:focus-visible` 3px outline 与 `prefers-reduced-motion` 块。

验证：

```bash
grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css   # 期望无输出
pnpm build
```

---

## 3. 组件

- [ ] 新增 `src/components/pagination-model.ts`：`pageCount` / `clampPage` / `pageRange`（纯函数，无 React）。
- [ ] 新增 `src/components/ui/Pagination.tsx`：总数 + 范围 + 可选 `note` + Mantine `Pagination`；
      `total === 0` 返回 `null`；`onPage` 用 `clampPage` 兜底；不 fetch、不改 state。
- [ ] 新增 `src/components/ui/List.tsx`：`List` / `ListItem` / `Eyebrow`（只输出结构与类名）。
- [ ] 新增 `src/components/status-badge.tsx`：`StatusBadge`（颜色映射单一来源，文案由调用方传 label）。
- [ ] `src/components/ui/Feedback.tsx`：props 与 `role` / `aria-live` 契约不变，内部换 Mantine `Alert` + `Loader`。

验证：

```bash
pnpm lint && pnpm typecheck
```

---

## 4. 服务端分页（契约变化）

- [ ] 新增 `src/lib/http/query.ts`：`parseIntegerParam` / `clampLimit` / `parsePageQuery`。
- [ ] `src/lib/service/bulletins.ts`：内部改用共用 helper，`parseBulletinListQuery` 对外行为不变。
- [ ] `src/app/api/settings/jev/usage/route.ts`：改用 `parsePageQuery`。
- [ ] `src/lib/domain/constants.ts`：新增 `NEEDS_LIST_DEFAULT_LIMIT=10`、`NEEDS_LIST_MAX_LIMIT=100`、
      `CHANNELS_LIST_DEFAULT_LIMIT=20`、`CHANNELS_LIST_MAX_LIMIT=200`。
- [ ] `src/lib/db/repos/needs.ts`：新增 `listNeedsPage`（`ORDER BY created_at ASC, id ASC`，`total` 同事务）。
- [ ] `src/lib/db/repos/channels.ts`：新增 `listChannelsPage`（`ORDER BY origin ASC, name ASC, id ASC`，`total` 同事务）。
- [ ] `src/app/api/needs/route.ts`：`GET` 支持 `limit`/`offset`，返回 `{ items, total }`。
- [ ] `src/app/api/channels/route.ts`：`GET` 支持 `limit`/`offset`，`channels` 返回一页；
      `selection` / `stats` 不变，**不新增 `total`**。
- [ ] `src/components/api-types.ts`：`NEEDS_PAGE_SIZE = 10`、`CHANNELS_PAGE_SIZE = 20`、`PagedItems<T>`。
- [ ] 不改 `/api/status`、`/api/channels/refresh`、`/api/channels/selection` 与 worker 的调用点。

验证：

```bash
pnpm typecheck && pnpm test
pnpm dev
curl -i localhost:3000/api/needs                                      # 未登录 → 401
curl -s -b "<session>" 'localhost:3000/api/needs?limit=abc&offset=-3'  # → 200，默认页大小，offset 归零
curl -s -b "<session>" 'localhost:3000/api/channels?limit=5'           # → channels ≤ 5，stats.total 为全量
```

**评审点 B（契约）**：确认 `/api/needs` 新增 `total`、`/api/channels` 的 `channels` 变成一页被接受。

---

## 5. 逐页改造（每页完成后跑 `pnpm lint && pnpm typecheck`）

顺序即影响面从小到大。

- [ ] `login/page.tsx`：`.auth-card` 发丝边；`PasswordInput` + `Button` + `Feedback`。
- [ ] `status/page.tsx`：健康摘要 `Section alt`；统计数字行；facts 走新样式；两表加
      「共 N 个频道有错误」/「最多显示最近 10 条」说明；`StatusBadge` 替换徽标。
- [ ] `bulletins/page.tsx`：表格 → `List`/`ListItem` + `Eyebrow` + `.list-title` 链接 + `.list-meta` + `.list-trailing`；
      `Select`（状态筛选，`全部` 用哨兵值 `all` 再映射回 `""`）、`Switch`（自动刷新）、`Button`；
      `Pagination` 替换手写分页；**删除收敛 `useEffect` 与 `eslint-disable`**，改用 `clampPage`。
- [ ] `bulletins/[id]/page.tsx`：header 重排；facts 与两表新样式；`pre` 行高与宽度；
      语义文案（处理失败、程序生成说明、filtered 说明、价格 null）逐条核对不变。
- [ ] `needs/page.tsx`：新增表单 `Section`；表格 → `List`（Eyebrow = 启用徽标 · v版本 · 更新时间；
      `TextInput` 保留 `key` + `onBlur` 提交；行尾 `Button variant="subtle"`）；
      `Switch` 替换启停、`Modal` 替换 `window.confirm` 删除确认；`Pagination`（10/页）；
      空态区分「还没有需求」与「本页没有记录」。
- [ ] `channels/page.tsx`：`Radio` 模式选择 + 「已选 N 个（含其它页）」；表格保留但走新样式（`Checkbox`）；
      `Pagination`（20/页）；空态判定改用 `stats.total === 0`；提交完整 `customIds`。
- [ ] `push/page.tsx`：凭证 `Fieldset` + `Switch`/`Radio`/`TextInput`/`PasswordInput`/`Button`；
      keyed form 与错误态 `Feedback` 保留；三态语义（保留/替换/清除）逐条核对。
- [ ] `jev/page.tsx`：配置区（`TextInput`/`NumberInput`/`Textarea`/`Radio`/`Fieldset`）、密钥区（表格走新样式）、
      用量区（摘要 facts、byKey 表、最近调用 + `Pagination` `unit="次调用"` + `clampPage`）；
      金额未知与 `$0.00` 禁令核对；保留 `id="jev-strategy"` 锚点。

验证（每页）：

```bash
pnpm lint && pnpm typecheck
pnpm dev   # 浅色 + 深色各看一遍；375px 宽检查横向溢出
```

**评审点 C（视觉验收）**：8 个页面 + 详情页在浅色/深色下整体走查，对照 `prd.md` 验收清单逐条打勾。

---

## 6. 测试补齐与最终门禁

- [ ] 新增 `tests/components/pagination-model.test.ts`。
- [ ] 新增 `tests/http/query.test.ts`。
- [ ] 扩展 `tests/db/repos.test.ts`：`listNeedsPage` / `listChannelsPage` 的 total、offset 窗口、
      `offset >= total` 为空、并列键跨页不重不漏。
- [ ] `pnpm lint` 全绿（确认 `bulletins/page.tsx` 的 `eslint-disable` 已删除且无新豁免）。
- [ ] `pnpm typecheck` 全绿。
- [ ] `pnpm test` 全绿。
- [ ] `pnpm build` 成功，`/api/*` 仍为 `ƒ (Dynamic)`，`/` 与 `/login` 静态。
- [ ] `grep -nE "#[0-9a-fA-F]{3,8}\b" src/app/globals.css` 无输出；页面里无新的裸 hex 颜色。
- [ ] 执行 `design.md` §9 的 10 条手工冒烟并记录结果（含浅色/深色各一遍、hydration 检查、375px）。

---

## 7. 收尾

- [ ] 更新 `.trellis/spec/frontend/index.md`：删除「no UI kit / no Tailwind」的单一口径，
      改为「Mantine v9 负责交互原语与主题；排版、条目列表、表格外壳仍在 `globals.css`；不引入 Tailwind 与状态库」。
- [ ] 更新 `.trellis/spec/frontend/component-guidelines.md`：新增
      ① 编辑式条目列表（`List`/`ListItem`/`Eyebrow` + `.list-*` 类）；
      ② 分页（`Pagination` + `clampPage` 派生，**禁用 `set-state-in-effect` 收敛**）；
      ③ Mantine 使用边界（用哪些、不用哪些、`StatusBadge` 是唯一颜色映射、`Modal` 替代 `window.confirm`、凭证仍三态）。
- [ ] 更新 `.trellis/spec/frontend/quality-guidelines.md`：新增深浅主题要求（禁止硬编码颜色、
      令牌必须别名 Mantine 变量、每页需在两种主题下检查、dev console 不得有 hydration 警告）。
- [ ] 更新 `.trellis/spec/frontend/directory-structure.md`：补 `src/theme.ts`、`src/components/status-badge.tsx`、
      `src/components/ThemeToggle.tsx`、`src/components/pagination-model.ts`、`postcss.config.mjs`。
- [ ] 更新 `.trellis/spec/frontend/type-safety.md`：记录 `NEEDS_PAGE_SIZE` / `CHANNELS_PAGE_SIZE` / `PagedItems`。
- [ ] 更新 `.trellis/spec/backend/directory-structure.md`（或 error-handling/quality）：
      `src/lib/http/query.ts` 是分页参数解析的唯一入口，路由不得自写 `parseIntegerParam`。
- [ ] 更新 `README.md`（若其中描述了「无 UI 库 / 无主题」或页面结构）：与现状对齐。
- [ ] 提交拆分（避免混入无关改动）：
      1. 依赖 + 主题骨架 + CSS → `git add package.json pnpm-lock.yaml src/theme.ts postcss.config.mjs src/app/layout.tsx src/app/globals.css`
         **但 `package.json` / `pnpm-lock.yaml` 用 `git add -p` 只取 Mantine/postcss 相关行**，
         把 `undici` 改动留给用户自己提交；
      2. 组件 + 服务端分页 + 测试；
      3. 逐页改造。
- [ ] 确认 diff 不含 `jevapikey`、不含 `src/lib/env.ts` 等无关改动后提交。
- [ ] 提交信息示例：`feat(ui): 管理台改编辑式列表、服务端分页与深色主题（Mantine v9）`。
- [ ] `python3 ./.trellis/scripts/task.py archive 10-16-admin-ui-redesign`。

---

## 回滚点

| 回滚点 | 范围 | 方式 |
| --- | --- | --- |
| A 之后 | 依赖 + 主题骨架 | 移除依赖、删除 `postcss.config.mjs` / `src/theme.ts`，回退 `layout.tsx` 与 `AdminNav.tsx` |
| CSS 之后 | 仅 `globals.css` | `git checkout -- src/app/globals.css` |
| B 之后 | 服务端分页 + 契约 | 回退 `src/lib/http/query.ts`、`src/lib/db/repos/{needs,channels}.ts`、两个 route、常量与 `api-types.ts` 新增项 |
| C 之后 | 页面改造 | 按页面逐个 `git checkout -- "src/app/(admin)/<page>/page.tsx"` |

无 schema 变更、无迁移，任何回滚都不涉及数据修复。
