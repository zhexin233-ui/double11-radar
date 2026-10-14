# 实施架构契约（实现与检查共同基准）

本文件把已批准的 design.md 落成可执行的工程契约，用于统一实现与检查。与 prd.md/design.md 冲突时以 prd.md/design.md 为准，本文件只补充工程细节。

## 1 技术栈与版本（锁定）

单一 pnpm 包（非 monorepo），根目录即应用根。

- Node 22（开发机 22.23，Docker 用 node:22-bookworm-slim）、pnpm 10。
- next ^16.4.0（App Router，output 默认 standalone）、react/react-dom ^19.3.0。
- typescript ~5.9（**不要**用 7.x），`strict: true`。
- better-sqlite3 ^13，同步 API，WAL 模式。
- zod ^4 做外部边界校验。
- vitest ^5 做单测；tsx ^4 运行 worker 与脚本。
- 不引入 Tailwind、UI 组件库、ORM、Prisma、Drizzle。样式用全局 CSS。

package.json scripts 必须包含：

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "worker": "tsx src/worker/main.ts",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "migrate": "tsx scripts/migrate.ts",
  "admin:hash": "tsx scripts/admin-hash.ts"
}
```

## 2 目录结构

```
src/
  app/
    layout.tsx  globals.css  page.tsx            # 重定向到 /status
    login/page.tsx
    (admin)/layout.tsx                           # 服务端校验会话，未登录 redirect /login
    (admin)/status/page.tsx
    (admin)/needs/page.tsx
    (admin)/channels/page.tsx
    (admin)/jev/page.tsx
    (admin)/push/page.tsx
    (admin)/bulletins/page.tsx
    (admin)/bulletins/[id]/page.tsx
    api/auth/{login,logout,session}/route.ts
    api/needs/route.ts  api/needs/[id]/route.ts
    api/channels/route.ts  api/channels/selection/route.ts  api/channels/refresh/route.ts
    api/settings/jev/route.ts  api/settings/jev/test/route.ts
    api/settings/notify/route.ts  api/settings/notify/test/route.ts
    api/bulletins/route.ts  api/bulletins/[id]/route.ts
    api/deliveries/[id]/retry/route.ts
    api/status/route.ts
  components/            # 客户端组件：表单、列表、状态徽标
  lib/
    env.ts               # 环境变量读取与校验（服务端 only）
    http/json.ts         # API 统一返回与错误包装、CSRF/同源校验
    auth/{password.ts,session.ts,guard.ts}
    crypto/secrets.ts    # AES-256-GCM 加解密
    db/{client.ts,migrate.ts,migrations.ts}
    db/repos/{needs.ts,channels.ts,bulletins.ts,evaluations.ts,jobs.ts,deliveries.ts,settings.ts,sessions.ts}
    domain/{types.ts,constants.ts}   # 领域类型、状态枚举、rule_version
    sources/xianbao/{client.ts,normalize.ts,types.ts}
    jev/{client.ts,prompt.ts,types.ts}
    notify/{bark.ts,feishu.ts,dispatch.ts,types.ts}
    notify/feishu-sign.ts
    worker/{main.ts,collector.ts,evaluator.ts,deliverer.ts,runtime-state.ts}
    service/{needs.ts,channels.ts,settings.ts,bulletins.ts,notify-config.ts}
tests/                   # vitest，覆盖 AC 边界
scripts/{migrate.ts,admin-hash.ts}
Dockerfile  docker-compose.yml  .env.example  README.md
```

约定：`src/lib/**` 为服务端代码，不得被客户端组件直接 import；客户端只通过 `/api/*` 访问。数据库访问只在服务端。

## 3 环境变量（src/lib/env.ts）

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | 是 | 持久化目录，默认 `/data`；SQLite 在 `$DATA_DIR/xianbao.db` |
| `APP_ENCRYPTION_KEY` | 是 | base64 32 字节，用于 AES-256-GCM；启动缺失时给出中文错误并退出 |
| `ADMIN_PASSWORD` | 是 | 部署配置的管理员明文密码；启动/首次使用时 scrypt 哈希写入 DB，DB 只存哈希 |
| `COOKIE_SECURE` | 否 | `true` 时 Cookie 加 Secure；默认 false 以便局域网 HTTP 首次部署 |
| `PORT` | 否 | 宿主机侧 web 发布端口，默认 3000（仅 compose 端口映射左侧使用；容器内固定监听 3000，应用不读取该变量） |
| `XIANBAO_API_BASE` | 否 | 默认 `https://new.xianbao.fun` |
| `APP_ENCRYPTION_KEY` 必须在 `docker-compose.yml` 与 `.env.example` 中说明生成方式（`openssl rand -base64 32`）。 |

web 与 worker 必须共用同一个 `DATA_DIR`、`APP_ENCRYPTION_KEY`、`ADMIN_PASSWORD`。

## 4 存储契约（SQLite 迁移）

`migrations.ts` 导出有序迁移数组；`migrate.ts` 用 `BEGIN IMMEDIATE` 在事务内按 `schema_migrations(version)` 逐条应用，`busy_timeout=5000`，WAL。web 通过 `src/instrumentation.ts` 的 `register()` 调用一次；worker 启动时调用一次。全部时间以 UTC ISO8601 字符串存储。

版本 1 建表（字段名固定，供跨模块共享）：

- `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
- `settings(namespace TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`
  命名空间：`jev`、`channels`（选择模式）、`notify`（渠道开关与 Bark 地址/飞书 webhook 是否配置的元数据）、`runtime`。
- `secrets(namespace TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL)`
  namespace：`jev.apiKey`、`bark.deviceKey`、`feishu.webhook`、`feishu.signingSecret`。
- `needs(id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
- `sessions(token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`
- `login_attempts(ip TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL)`
- `channels(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, alias TEXT, origin TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1, selected INTEGER NOT NULL DEFAULT 1, initialized INTEGER NOT NULL DEFAULT 0, cache_ttl_seconds INTEGER NOT NULL DEFAULT 10, next_poll_at TEXT, last_success_at TEXT, last_error_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  `origin` 取值 `feed` / `zdm`；`id` 为稳定来源标识（feed 用分类 ID/别名，zdm 用 `zdm`）。
- `channel_catalog(id TEXT PRIMARY KEY, name TEXT, alias TEXT, origin TEXT NOT NULL, raw TEXT NOT NULL, fetched_at TEXT NOT NULL)`
- `bulletins(id TEXT PRIMARY KEY, source TEXT NOT NULL, source_ns TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, content TEXT, category TEXT, price REAL, brand TEXT, mall TEXT, published_at TEXT, payload TEXT NOT NULL, content_version TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(source, source_ns, source_id))`
  `price` 缺失为 NULL，绝不用 0 代替。
- `jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload_key TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5, run_at TEXT NOT NULL, lease_until TEXT, lease_owner TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(payload_key))`
  kind：`evaluate`、`deliver`；status：`pending|leased|succeeded|dead`。
- `notifications(id TEXT PRIMARY KEY, bulletin_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, created_at TEXT NOT NULL)`
- `evaluations(id TEXT PRIMARY KEY, bulletin_id TEXT NOT NULL, need_id TEXT NOT NULL, need_name TEXT NOT NULL, need_note TEXT NOT NULL, need_version INTEGER NOT NULL, config_version INTEGER NOT NULL, rule_version TEXT NOT NULL, result TEXT NOT NULL, probabilities TEXT, confidence REAL, raw_answer TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(bulletin_id, need_id, rule_version))`
  `result`：`matched|not_matched|uncertain|failed`。
- `deliveries(id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, bulletin_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, lease_owner TEXT, http_status INTEGER, biz_code TEXT, response TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(notification_id, channel))`
  status：`pending|sending|succeeded|failed|disabled`。已 `succeeded` 的行不得被同一任务重新领取。

## 5 领域类型（src/lib/domain/types.ts）

集中定义并由各层 import，禁止在消费端对 `unknown` 做局部断言：

- `EvaluationResult`、`DeliveryStatus`、`JobKind`、`JobStatus`。
  实现说明：契约原先列出的 `NeedStatus` 被 `Need.enabled: boolean` 取代（数据库仍以 0/1 存储），
  避免同一语义存在两套表示。
- `NormalizedBulletin`：`{ source, sourceNs, sourceId, url, title, content, category, price: number|null, brand, mall, publishedAt, payload, contentVersion }`。
- `ChoiceOutcome = 'matched' | 'not_matched' | 'uncertain'`。
- `RULE_VERSION` 常量（Jev 问题模板版本，初值 `systemone-choice-v1`）。

`contentVersion`：对 `title|content|category|price|brand|mall` 求 sha256 前 16 位。

## 6 采集契约（src/lib/sources/xianbao）

实测响应结构见 `research/xianbao-live-samples.md`，那份文件是字段与固定样例测试的唯一依据。

- 统一外层信封 `{code,msg,data,meta}`；**必须先校验 `code === 0`** 再读 data，非 0 视为业务失败。
- `meta/client.ts`：`fetchMeta()` → 用 zod 校验 `unknown`，产出开放频道列表 `{id, name, alias, origin}` 与 `cacheTtl`（meta 实测 `meta.cache_ttl=600`，按 600 秒缓存 meta）。
  - **必须跳过 `zhidemai` 分类流**（与 `zdm` 独立流覆盖同一内容，避免双编号空间重复采集）；`zdm` 作为独立频道附加。
  - 不把 `all`（缺省全站流）作为频道轮询，避免与逐频道重叠。
  - meta 失败不得抛未捕获异常拖垮 worker。
- `fetchFeed(channel, signal)`：
  - feed 普通流：`GET /api/v1/feed?cate=<alias|id>&limit=50`；zdm：`GET /api/v1/feed?type=zdm&limit=50`。
  - 分类流快照最多 20 条、zdm 30 条，limit 不等于历史分页；只按返回内容处理，不做分页补齐。
  - 频道轮询间隔使用 feed 响应 `meta.cache_ttl`（实测 10 秒）作为下限，并满足全局限流预算（60 次/分钟/IP/接口）。
  - 429：读 `Retry-After` 与 `X-RateLimit-Reset`；失败抛带 `status`/`retryAfterMs` 的类型化错误。
- `normalize.ts`：feed 与 zdm 两个独立 zod schema 与 normalize 函数（不共用 item 解析）。字段缺失为 null；`price` 非有限数或缺失时为 null；`published_at`（Unix 秒）→ UTC ISO8601。
  - `sourceNs`：feed 为 `feed:<channelAlias>`，zdm 为 `zdm`；`sourceId`：feed 为字符串化数字 id，zdm 为站外字符串 id。
  - feed 的 `category` 优先取 `item.category.name`（细分品类），回退 `data.category.name`；zdm `content` 恒为 null，`category` 取 `category_name`，另有 `brand`/`mall`。
- 去重键：`(source='xianbao', source_ns, source_id)`。

## 7 Jev 契约（src/lib/jev）

- `POST {baseUrl}/v1/systemone`，`Authorization: Bearer <apiKey>`，body `{ state, model, questions }`。
- `state`：`{ 线报标题, 正文, 品类, 品牌, 商城 }`（只带有值的字段）字符串化 JSON。
- `questions`：`Record<questionId, { type: 'choice', criteria: {...}, instructions: string }>`，questionId 为程序生成的稳定键（如 `need_<needId>`），需求名称与备注写入 `instructions`，**不依赖键名承载需求语义**。
- criteria 三态键固定为 `matched` / `not_matched` / `uncertain`，语义在 criteria 文本中说明（明确符合 / 明确不符或违反备注约束 / 证据不足或仅品牌相关）。
- 响应 `answers[questionId]`：校验类型为 choice 且 chosen ∈ 三态；未知 choice、结构不符、缺答案 → 该 need 记 `failed`（不伪造命中）。
- 输出仅使用 chosen / probabilities / confidence；**不要求也不解析自由文本理由**。
- 超时使用 `timeoutMs`（配置项，默认 20000）；网络/HTTP/解析失败有限重试（job max_attempts=5，指数退避）。
- `prompt.ts` 负责构造 questions 与从 answers 得到 `ChoiceOutcome`；单测覆盖未知 choice、缺答案、类型不符、超时。
- 程序模板说明：`该线报被 Jev 判为符合需求：<需求名>`，并在 UI 明确标注为「程序生成的分类说明」，不得表述为模型生成的解释。

## 8 通知契约（src/lib/notify）

Bark（一个设备）：
- 地址由配置的 `serverUrl`（默认 `https://api.day.app`）+ 设备 Key 组成；POST JSON 或 GET 路径均可，统一用 POST `{url}/push`。
- body：`{ device_key, title, body, url: <原始线报链接>, group: '线报需求匹配' }`。
- 成功判定：HTTP 2xx 且响应 JSON `code === 200`。响应可能返回非 JSON，需容错。

飞书群 Webhook（一个群）：
- POST webhook URL，`msg_type: 'post'`，`content` 为对象（群 webhook 是对象，不是字符串化的 JSON）。
- 富文本用 `zh_cn.title` + `content` 段落，链接用 `{tag:'a', text:'查看原始线报', href: url}`。
- 开启签名时：`stringToSign = timestamp + '\n' + secret`，以 stringToSign 为 HMAC-SHA256 key、空消息为 data，Base64 结果作为 `sign`；`timestamp`（秒）与 `sign` 置于 body 顶层，时间偏差 ≤ 3600 秒。
- 关键词校验：可选前缀 `keywordPrefix`，通知标题/正文必须包含它。
- 成功判定：HTTP 2xx **且** 业务 `code === 0`；非零码记为失败并保存 `biz_code`。
- 非零码分类：`19021/19022/19024` 视为配置错误（不自动重试，标记 failed 并在 UI 提示）；`11232` 等限流/瞬时错误可重试。

`dispatch.ts`：
- 一条线报的全部命中需求合并为一条通知（`notifications.payload` 含命中需求列表、原始标题、程序分类说明、原始链接、存在的价格/条件）。
- 事务内创建 notification 与每个已启用渠道的 delivery；渠道独立启停；渠道全关只记判断、不建 delivery。
- 幂等：deliver job 的 `payload_key = 'deliver:' + deliveryId`；`deliveries` 唯一约束；重试只针对 `failed` 渠道。
- HTTP 超时属未知结果：记录 error，允许重试，UI 不得承诺绝对不重复。

## 9 鉴权契约（src/lib/auth）

- 单管理员。`ADMIN_PASSWORD` 由部署提供；启动时用 scrypt 生成/校验哈希，DB `settings('auth')` 只保存 `{ passwordHash, algo:'scrypt', salt, N/r/p }`。
- 登录：POST `/api/auth/login {password}` → 校验 → 生成 32 字节随机 token，DB 存 `sha256(token)`，Cookie `xianbao_session`（HttpOnly、SameSite=Lax、Path=/、Max-Age=7d、按 `COOKIE_SECURE` 决定 Secure）。
- 会话校验：`getSession()` 读 cookie → 查 DB → 过期即删；滑动续期。退出删除该行并清 cookie。
- 登录失败限速：按 IP，5 次失败锁 5 分钟；记录 `login_attempts`。
- 所有 `/api/*` 写操作与读取配置/记录的接口必须在服务端校验会话；未登录返回 401 JSON，不得仅靠前端跳转。
- 同源保护：写操作校验 `Origin`（存在时必须与 Host 同源）并强制要求自定义头 `x-requested-with: fetch`（前端统一 fetch 封装携带）。
- 中间件或 `(admin)/layout.tsx` 服务端校验；API 侧使用 `guard.ts` 的 `requireSession()`。

## 10 凭据与配置读写契约

- 敏感字段（Jev apiKey、Bark deviceKey、飞书 webhook、飞书 signingSecret）加密存 `secrets` 表，AES-256-GCM，`iv:tag:ciphertext` 三段 base64 拼接。
- GET 配置只返回 `configured: boolean` 与掩码（如 `sk-****abcd` 不返回真实值）以及非敏感项；**绝不回传可还原的明文**。
- PUT 配置的三态语义：字段缺失/`null` = 保留旧值；`''` 空串 = 保留旧值（不是清除）；`{ clear: true }` 或显式 `action:'clear'` = 清除。前端提供「保留 / 替换 / 清除」显式操作。
- 保存后 `settings.version` 自增；新任务记录使用的 config_version。进行中的任务保留其快照。
- 测试按钮只做单次测试（Jev 连接测试、Bark 测试、飞书测试），不触发历史回放。
- 测试结果返回清洗后的信息，不回传可能含凭据的上游原始请求/响应。

## 11 采集基线与调度

- 频道首次成功获取快照：同一事务内为该频道内所有新 `bulletins` 写 `baseline=1`，并置 `channels.initialized=1`。
- 若该 `bulletin` 已被其他频道入队/判断/投递，则**不得**把其状态改回 baseline、删除其 evaluations/jobs/deliveries。实现方式：插入时 `INSERT OR IGNORE`，仅对本次真正新插入的行设 baseline。
- `initialized=0` 的频道首次获取失败：不置 initialized，记 `last_error`，稍后重试。
- 已初始化频道的新条目（`baseline=0`）才创建 `evaluate` job。
- 停用频道保留 initialized 与已存数据；重新启用继续处理当前可见且未见过的条目。
- 调度：`channels.next_poll_at = now + max(cache_ttl_seconds, 10)`；全局限流预算（如每分钟 ≤ 50 请求）与 429 退避；单个频道失败不影响其他频道。
- 选择模式存 `settings('channels')`：`{ mode: 'all' | 'custom', customIds: string[] }`。all 模式跟随能力清单（新增频道自动纳入）；custom 模式下新增频道默认不启用；撤下的频道置 `available=0` 并停止请求，不删除已存线报。

## 12 Worker 运行时

- `src/worker/main.ts`：加载 env → migrate → 启动 heartbeat 定时器 → 并发运行 collector / evaluator / deliverer 三个循环（各自 try/catch，单个循环崩溃不拖垮进程）。
- 领取任务用事务 + 租约：`UPDATE jobs SET status='leased', lease_owner=?, lease_until=now+60s WHERE id=(SELECT id FROM jobs WHERE status='pending' AND run_at<=now ORDER BY run_at LIMIT 1)`；崩溃超时后 `leased` 过期任务可由 `reclaimExpired()` 重置为 pending。
- worker 把 `runtime` 状态写入 settings：`workerStartedAt`、`lastHeartbeatAt`、`lastCollectAt`、`lastEvaluateAt`、`lastDeliverAt`、`lastError`。
- 关闭网页不影响 worker（独立进程）。
- `web` 与 `worker` 不重复启动同一采集轮次（用 `next_poll_at` 的原子更新 `UPDATE ... WHERE next_poll_at <= now` 保证）。

## 13 API 与页面行为

- 所有 API 统一返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`，中文 message。
- `/api/status` 返回：频道概览（总数/已启用/未初始化/最近错误）、后台心跳与最后采集/判断/投递时间、最近失败任务、区分「没有匹配」与「处理故障」。
- 需求页支持新增/编辑/启停/删除；禁用只影响后续任务，删除保留历史 evaluations 中的需求快照。
- 线报页展示标题、链接、频道、时间、价格（null 显示为空而非 0 元）、判断状态、程序分类说明；支持展开查看每个需求的 Choice 结果、probabilities/confidence；支持对失败渠道重试。
- 页面文案必须区分：没有匹配 / 待确认（uncertain）/ 处理失败。

## 14 部署契约

- `Dockerfile`：多阶段（deps → build → runner），`node:22-bookworm-slim`，corepack 启用 pnpm，装 better-sqlite3 需要 build-essential + python3（若无预编译包）。最终镜像含 standalone 输出与 worker 依赖；`CMD` 由 compose 覆盖。
- `docker-compose.yml`：`web` 与 `worker` 同镜像不同命令；只有 web 发布 `${PORT:-3000}:3000`；共享 volume `xianbao-data:/data`；`env_file: .env`；healthcheck 命中 `/api/health`（新增 GET /api/health，无需登录，仅返回 `{ok:true}`）。
- `.env.example`：含 DATA_DIR、APP_ENCRYPTION_KEY、ADMIN_PASSWORD、COOKIE_SECURE、PORT 及生成说明。
- `README.md`（简体中文）：部署步骤、网页配置、测试方法、备份/恢复（数据库 + APP_ENCRYPTION_KEY 必须同时备份）、快照覆盖限制、未实测声明。
- `next.config.ts` 设置 `output: 'standalone'`，`serverExternalPackages: ['better-sqlite3']`。

## 15 测试要求（vitest，使用临时 SQLite 文件）

至少覆盖：

1. 会话：未登录访问受保护 API 返回 401；登录/退出；登录失败限速。
2. 凭据三态：保留/替换/清除；GET 不回传明文；重启用同一 APP_ENCRYPTION_KEY 可解密。
3. 采集：meta 失败可恢复；all/custom 选择；来源身份去重；feed 与 zdm 字段差异；price 缺失为 null。
4. 基线：首次快照不产生 evaluate job 与通知；新条目产生；已由另一频道入队的记录在新频道基线化时不被降级/取消。
5. Jev：正例/反例/不确定样例（mock 传输层）；未知 choice、缺答案、类型不符、超时不计命中；多需求关联正确。
6. 通知：多需求合并为一条；Bark 成功/飞书失败只重试飞书；飞书 business code 非 0 记为失败；正确签名生成；两渠道关闭时不建 delivery；已成功投递不会被本地重放。
7. worker：租约过期回收；重启后继续未完成任务；数据持久化。
8. 状态：故障与「没有匹配」在 `/api/status` 中可区分。

测试不得把 mock 通过描述为真实接口已验证。
