# 现状盘点：管理台 UI 与列表基数审计

审计时间：2026-10-16（改动前）。用途：为视觉重构与分页范围划定提供依据。

---

## 1. 文件与行数

| 文件 | 行数 | 类型 |
| --- | --- | --- |
| `src/app/globals.css` | 770 | 全站样式（令牌 / 基础元素 / 壳层 / 区块 / 表格徽标按钮 / 响应式） |
| `src/app/(admin)/layout.tsx` | 34 | 服务端布局：会话校验 + `AdminNav` + `.admin-main` |
| `src/app/(admin)/status/page.tsx` | 233 | client |
| `src/app/(admin)/bulletins/page.tsx` | 202 | client |
| `src/app/(admin)/bulletins/[id]/page.tsx` | 306 | client |
| `src/app/(admin)/needs/page.tsx` | 193 | client |
| `src/app/(admin)/channels/page.tsx` | 234 | client |
| `src/app/(admin)/jev/page.tsx` | 828 | client（含 `JevForm` / `JevKeyAddForm` / `JevKeyRow` / `JevUsagePanel`） |
| `src/app/(admin)/push/page.tsx` | 304 | client（含 `SecretField` / `PushForm`） |
| `src/app/login/page.tsx` | 56 | client |
| `src/components/AdminNav.tsx` | 83 | client |
| `src/components/ui/*.tsx` | 22–39 | 纯展示原语 |

## 2. 现有样式骨架

- 令牌：`--bg #f5f5f7`、`--surface #fff`、`--accent #0066cc`、`--r-panel 20px`、`--header-pad-block 64px`、`--content-max 1200px`。
- 容器语言：`.section` / `.card` 都是「白色 + 20px 圆角 + 大内边距」，靠底色差浮在灰底上；
  唯一的分割线是 `--border` 表格线与 `hr`。
- 没有：条目分割线、小标签（eyebrow）刻度、悬停整行反馈、分页样式、`.list*` 类。
- 表格：`table/th/td` 全局样式 + `.table-scroll`（`--table-min` 控制最小宽度）。
- 徽标：`.badge` + `.matched/.uncertain/.failed/.pending/...` 语义色（保留，需保留文案映射来源）。

## 3. 各页列表：基数与当前分页状态

| 页面 | 列表 | 数据来源 | 服务端是否分页 | 实际基数 |
| --- | --- | --- | --- | --- |
| status | 频道错误表 | `GET /api/status` → `channels.failing` | 否（全量） | 出错频道数，诊断用 |
| status | 最近失败任务表 | `GET /api/status` → `recentFailedJobs` | 否，但服务端 `listRecentFailedJobs(db, 10)` 硬限 10 | 固定 ≤ 10 |
| bulletins | 线报记录 | `GET /api/bulletins?limit&offset&status` | **是**（默认 50，仓库 clamp 1..200） | 无限增长 |
| bulletins/[id] | 逐需求判断表 | detail 内嵌 `evaluations` | 否 | 启用需求数（十位级） |
| bulletins/[id] | 渠道投递表 | detail 内嵌 `deliveries` | 否 | 渠道数（当前 2） |
| needs | 现有需求表 | `GET /api/needs` → `{ items }` | **否，全量** | 用户持续新增，无限增长 |
| channels | 采集频道表 | `GET /api/channels` → `{ channels, selection, stats }` | **否，全量** | 官方能力清单，可达上百 |
| jev | API 密钥表 | `GET /api/settings/jev` → `keys` | 否 | Key 池规模（个位~十位） |
| jev | 按 Key 调用汇总 | `GET /api/settings/jev/usage` → `byKey` | 否 | Key 数量 |
| jev | 最近调用表 | 同上 → `recent.items` + `recent.total` | **是**（默认 20） | 无限增长 |
| push | 无列表 | `GET /api/settings/notify` | — | — |

结论：需要补分页的是 **needs**（无限增长）与 **channels**（可达上百）；其余列表要么已有分页，要么基数有界。

## 4. 分页实现现状（两套手写）

- `bulletins/page.tsx`：`page` state → `offset = page * BULLETIN_PAGE_SIZE` → 拼 `path`；
  用 `useEffect` + `eslint-disable react-hooks/set-state-in-effect` 在 `total` 缩减时回退页码；
  分页 UI 是 `.toolbar` + 两个 `.btn-ghost` + `.muted.small` 计数。
- `jev/page.tsx` 的 `JevUsagePanel`：`props.page` / `props.onPage` + `USAGE_PAGE_SIZE`，
  禁用条件是 `(page + 1) * PAGE_SIZE >= total`；文案是 `共 N 次调用`。
- 两处按钮文案相同但结构、文案、边界判断都不一样，无共用组件。

## 5. 服务端分页工具现状

| 位置 | 内容 |
| --- | --- |
| `src/lib/service/bulletins.ts` | 模块内私有 `parseIntegerParam(raw, fallback)` + `parseBulletinListQuery`（status 校验、baseline 固定 false） |
| `src/app/api/settings/jev/usage/route.ts` | 又一份私有 `parseIntegerParam`（注释：非法输入必须回退而不是变成 500） |
| `src/lib/db/repos/bulletins.ts` | `listBulletins` 内部自行 `limit = clamp(1..200)`、`offset = max(0)`，返回 `{ items, total }`（count 与 page 同事务） |
| `src/lib/db/repos/jev-requests.ts` | `Math.trunc` + `Number.isFinite` 回退，`LIMIT @limit OFFSET @offset` |
| `src/lib/db/repos/needs.ts` | `listNeeds(db)` 全量，`ORDER BY created_at ASC` |
| `src/lib/db/repos/channels.ts` | `listChannels(db)` 全量，`ORDER BY origin ASC, name ASC`；`channelStats(db).total` = 全部频道数 |

## 6. 客户端契约与约束（来自 `.trellis/spec/frontend/`）

- `src/components/ui/` 只能放展示原语：不 fetch、不持业务状态、不引 `@/lib/**`。
- 客户端 DTO 只在 `src/components/api-types.ts`；不得对响应做 `as` 断言；`| null` 而非可选字段。
- 状态文案必须走 `STATUS_LABELS` / `EVALUATION_LABELS` / `DELIVERY_LABELS` / `EVALUATION_MODE_LABELS` / `PROCESSING_SOURCE_LABELS`。
- 金额未知 `null`：**绝不显示 `$0.00` / `0 元`**。
- `react-hooks/set-state-in-effect`：数据加载只能走 `useApiResource`；配置表单必须用 `key` 重挂载。
- 空表格要渲染空态段落，宽表必须包 `TableScroll` 且给 `minTableWidth`。
- 每页恰好一个 `h1`；`.page` 包裹内容；凭证区必须 `<fieldset><legend>` + 保留/替换/清除。

## 7. 参考站点观察（cssdesignawards.com）

可借鉴的分割语言（只取语言，不照搬配色）：

- 条目之间用 1px 发丝线分隔，垂直留白明显大于条目内部行距；
- 每条的信息层级固定：小号字距标签（类别/奖项）→ 大号标题 → 次级元信息；
- 容器本身几乎没有边框与阴影，页面底色即是容器；
- 悬停时整行有底色/位移反馈，而不是只给链接加下划线；
- 数字与元信息用等宽数字，翻页/对比时不跳动。

本项目数据里**没有图片字段**，条目左侧不放缩略图，改由「状态徽标 + 来源 + 时间」的小标签行承担视觉锚点。
