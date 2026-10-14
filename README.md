# 线报需求匹配与推送

在本地 NAS 上持续监控线报酷（https://new.xianbao.fun），用 TypeSafe Jev 的原生 System One
接口把新线报与你配置的购买需求逐项做语义匹配，只把**明确匹配**的线报推送到 Bark 与飞书群。

- 单管理员密码登录，局域网网页配置需求、频道、Jev 与推送渠道。
- 采集、判断、投递由独立后台进程执行，关掉网页不会停止。
- 首次启动只建立基线，只处理之后出现的新线报。
- 一条线报命中多个需求时合并为一条通知。

> 交付状态：产品代码与自动化测试已完成，`pnpm typecheck` / `lint` / `test` / `build` 通过，
> 并用真实线报酷公开 API 验证过采集与基线行为。**尚未使用真实的 Jev / Bark / 飞书凭据做端到端
> 验证**；单元测试与冒烟测试全部基于注入的假传输层，不代表真实模型准确率或真实送达。

## 1 快速部署（Docker Compose）

> 依赖版本固定说明：`package.json` 里有 `packageManager: pnpm@10.13.1`。容器内 corepack 会按它
> 安装指定 pnpm；若不加固定，corepack 会拉取最新 pnpm（实测 12.x），其 `minimumReleaseAge`
> 供应链策略会拒绝当天刚发布的传递依赖，导致 `docker compose build` 失败。

```sh
git clone <本仓库> && cd 11jev
cp .env.example .env

# 生成 32 字节 base64 加密密钥，填入 .env 的 APP_ENCRYPTION_KEY
openssl rand -base64 32

# 设置管理员密码（写入 .env 的 ADMIN_PASSWORD）
# 可选：核对将被保存的 scrypt 哈希
pnpm install && pnpm admin:hash

docker compose up -d --build
docker compose ps           # web 应为 healthy
docker compose logs -f worker
```

打开 `http://<NAS-IP>:3000`，用 `ADMIN_PASSWORD` 登录。

### 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `APP_ENCRYPTION_KEY` | 是 | base64 编码的 32 字节密钥，用于 AES-256-GCM 加密 Jev/推送凭据。**必须稳定不变**，否则已保存凭据无法解密。 |
| `ADMIN_PASSWORD` | 是 | 管理员登录密码。明文只来自部署配置，数据库只保存 scrypt 哈希。 |
| `DATA_DIR` | 否 | 持久化目录，默认 `/data`；SQLite 位于 `$DATA_DIR/xianbao.db`。 |
| `COOKIE_SECURE` | 否 | 局域网 HTTP 首次部署请保持 `false`；经反向代理提供 HTTPS 时设为 `true`。 |
| `PORT` | 否 | **宿主机侧** web 发布端口，默认 `3000`。只影响端口映射的左侧，容器内固定监听 `3000`。 |
| `XIANBAO_API_BASE` | 否 | 线报酷基地址，默认官方地址。 |

web 与 worker 必须使用**完全相同的** `DATA_DIR`、`APP_ENCRYPTION_KEY`、`ADMIN_PASSWORD`。
compose 已通过共享 `.env` 与同一数据卷保证这一点。

## 2 网页配置顺序

1. **Jev 配置**：服务地址（默认 `https://api.typesafe.ai`）、模型标识（默认 `jev-latest`）、
   API 密钥、超时。点击「测试连接」做单次验证（不会回放历史线报）。
2. **采集频道**：默认全部开放频道；也可保存自定义选择。首次成功快照只建立基线。
3. **需求清单**：填写需求名称（如「抽纸」）与可选备注（如「不要湿巾」），支持启停与删除。
4. **推送渠道**：Bark 服务地址 + 设备 Key；飞书群机器人 Webhook（可选签名密钥与关键词前缀）。
   分别启停、分别测试。
5. **需求试判**（Jev 页底部，仅验收用）：粘贴一段线报样例（标题/正文/可选品类、品牌、商城、价格），
   用与生产相同的问题与解析逻辑调真实 Jev，逐需求显示匹配/不匹配/信息不足。
   它**不写入判断记录、不产生通知或投递**，用于在真实线报出现之前验证语义正反例。
   页面内置了「抽纸 / 软抽 / 湿巾 / 卷纸 / 只有品牌」几个样例按钮。
6. 回到**运行状态**确认 worker 心跳正常、频道已建立基线。

密钥类字段采用三态操作：**保留原值 / 替换 / 清除**。留空不会清除已保存的凭据；
页面读取只显示掩码，不回传明文。

## 3 本地开发

```sh
pnpm install
cp .env.example .env            # 至少填写 APP_ENCRYPTION_KEY 与 ADMIN_PASSWORD
export DATA_DIR=$PWD/data       # 开发时避免使用 /data

pnpm dev                        # 网页与 API
pnpm worker                     # 另开一个终端运行后台进程
```

质量门禁：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config
docker compose build
```

## 4 行为说明与边界

- **基线**：每个频道首次成功获取快照时，其中的条目标记为基线，不调用模型、不通知；
  之后新出现的条目才进入判断。容器重启沿用持久化的基线与未完成任务，不会重新回推。
- **跨频道**：同一文章在不同频道属于不同来源编号空间，建立新频道基线不会修改其它频道
  已有记录、判断或投递任务。
- **限流与快照窗口**：官方接口为 60 次/分钟/IP/接口（实测响应头 `x-ratelimit-limit: 60`，
  并返回 `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After`）。分类流只保留最新 20 条、
  值得买 30 条，没有历史分页。应用的调度策略是：
  - 稳态目标只取额度的一半（30 次/分钟），即每频道间隔 `max(cache_ttl, ceil(60×频道数/30))` 秒；
  - 同一轮内两次频道请求之间保留 1.2 秒间隔，避免突发；
  - 失败重试不早于稳态间隔，避免重试流量叠加；
  - 当响应头显示剩余额度 ≤ 5 时，全局暂停采集到窗口重置，再继续。
  **注意额度是按出口 IP 计的**：同一 IP 上的其它客户端（包括调试脚本）会与本应用共享这 60 次，
  因此不要在同一 IP 上并行运行第二个采集进程。
  长时间停机或高峰仍可能遗漏，**不承诺补齐完整历史**。
- **值得买**：分类流中的 `zhidemai` 与 `type=zdm` 独立流覆盖同一内容，应用只使用独立流，
  避免双编号空间重复采集。
- **配置错误可恢复**：Jev 未配置或密钥无效导致的判断失败不会把任务判死，而是保持待处理并按
  5 分钟间隔重排；你在网页配置好正确的凭据后，已排队的线报会被自动判断，无需手工补数据。
- **判断三态**：`matched` 才通知；`uncertain`（信息不足）留在网页待确认；
  `not_matched` 只保存记录。模型调用失败或返回结构不合法记为「处理失败」，
  与「没有匹配」严格区分，绝不伪造成命中。分类说明由程序模板生成，不是模型生成的理由。
- **投递**：两个渠道独立启停、独立状态、独立重试。一个成功一个失败时只重试失败渠道；
  已成功渠道不会被本地重放。飞书必须 HTTP 200 且业务 `code === 0` 才算成功；
  `19021/19022/19024` 视为配置错误，停止自动重试并在网页提示。
- **未知结果**：网络超时属未知状态，允许重试，因此无法承诺绝对零重复或用户已读。
- **本期不包含**：历史低价判断、自动下单、历史线报批量回放、飞书应用/个人消息、
  多设备/多群/多账号、跨文章活动合并。

## 5 备份与恢复

必须同时备份**数据库与加密密钥**，缺一不可：

```sh
# 备份（例如通过容器）
docker compose stop worker
docker run --rm -v xianbao-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/xianbao-backup-$(date +%Y%m%d).tar.gz -C /data .
docker compose start worker
```

同时保存 `.env` 中的 `APP_ENCRYPTION_KEY`。恢复时把数据卷内容还原到 `DATA_DIR`，
并使用**同一个** `APP_ENCRYPTION_KEY` 启动；否则 Jev 与推送凭据无法解密。

升级前先备份。数据库迁移是幂等且串行的，但旧镜像不保证能读取新版本迁移后的数据结构。

## 6 故障排查

| 现象 | 处理 |
| --- | --- |
| 运行状态显示「处理故障」 | 检查 `docker compose logs worker`；确认 worker 心跳在 2 分钟内。 |
| 频道显示采集错误 | 查看错误文本；429 会自动退避，其它错误按频道隔离，不影响其他频道。 |
| 判断一直失败 | 检查 Jev 配置与 API 密钥；「处理失败」不等于没有匹配。 |
| 未登录直接调 API 被拒 | 属预期行为：配置、记录、测试与重试接口都要求登录会话。 |

## 7 架构

- TypeScript + Next.js（App Router，serverExternalPackages 中排除 `better-sqlite3`）
- SQLite（better-sqlite3，WAL）持久化配置、线报、判断与投递记录
- 独立 worker 进程：采集 → 判断 → 投递，事务 + 租约领取，崩溃可恢复
- 凭据使用 AES-256-GCM 加密存储；会话使用服务端可验证的 HttpOnly Cookie
- 所有外部请求（线报酷 / Jev / Bark / 飞书）都由 NAS 主动发出，不开放入站端口

工程契约与设计细节见 `.trellis/tasks/10-13-xianbao-needs-matching/` 下的
`prd.md`、`design.md`、`implement.md` 与 `research/impl-architecture.md`。
