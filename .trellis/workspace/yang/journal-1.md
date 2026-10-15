# Journal - yang (Part 1)

> AI development session journal
> Started: 2026-10-13

---



## Session 1: 线报需求匹配与推送：从规划到真实凭据验收

**Date**: 2026-10-14
**Task**: 线报需求匹配与推送：从规划到真实凭据验收
**Branch**: `main`

### Summary

在空仓库从零实现单管理员网页应用：线报酷采集与首快照基线、TypeSafe Jev 原生 System One 三态判断、Bark/飞书分渠道投递与独立重试、Docker Compose 同镜像 web/worker 部署。127→138 个测试，真实 Jev 凭据下 7/7 语义正反例符合预期。

### Main Changes

- Next.js + SQLite + 独立 worker：迁移/事务/租约、单管理员 scrypt 登录、凭据 AES-256-GCM 加密且读取只回掩码
- 采集按限流预算与缓存时间调度，跳过 zhidemai 分类流避免双编号空间重复，首次快照只建基线
- 判断并发数与每轮任务数改为网页可配（默认 1 / 3），配置错误保持可恢复重试而非判死
- 新增仅验收用的需求试判（dry-run）：复用生产链路调真实 Jev，不写库不通知

### Git Commits

| Hash | Message |
|------|---------|
| `8109b0f` | (see git log) |
| `ff09eb8` | (see git log) |
| `ff7695e` | (see git log) |
| `3cad9ff` | (see git log) |
| `c8a4254` | (see git log) |
| `12c4648` | (see git log) |
| `d69df1c` | (see git log) |
| `bf56010` | (see git log) |
| `d4a617d` | (see git log) |
| `29f3812` | (see git log) |
| `b2bda74` | (see git log) |
| `5d01e6c` | (see git log) |
| `0347195` | (see git log) |
| `9fae1e5` | (see git log) |
| `a91487a` | (see git log) |

### Testing

- [OK] pnpm lint / typecheck / 138 测试 / build 全绿；Docker 镜像构建 27 秒、web healthy
- [OK] 容器内实测：基线不产生任务、假命中为 0、限流自适应后 0 个 429
- [OK] 真实 Jev：连接测试通过，抽纸/软抽命中、湿巾/卷纸不命中、仅品牌判信息不足，7/7 符合预期

### Status

[OK] **Completed**

### Next Steps

- Bark 真实送达验收（需真实设备 Key 与手机确认）；飞书按用户要求暂缓
- amd64 镜像未构建验证（本机仅 arm64）
- 考虑补投递能力：渠道后启用时无法补发历史命中通知

## Session 2: Jev 多密钥并发、费用统计与线报记录筛选刷新

**Date**: 2026-10-14
**Task**: Jev 多密钥并发、费用统计与线报记录筛选刷新
**Branch**: `main`

### Summary

在已批准方案上完成实施：Jev Key 池（多 Key 并发、连续三次实际失败自动禁用、可手动恢复/替换）、统一调用账本与美元费用估算、Worker 租约/owner 保护、需求合并语义回归、线报记录页状态筛选/分页与默认关闭的五秒自动刷新。测试 138→201，四门禁与 docker compose config 全绿。

### Main Changes

- 新增 V2 迁移（`jev_api_keys`、`jev_requests`）与 `src/lib/{db/repos,service}/jev-*.ts`、`src/lib/jev/pricing.ts`；迁移 runner 改为在 `BEGIN IMMEDIATE` 内读取已应用版本，旧单密钥密文原样迁移到 `jev.key.legacy-default`
- 统一请求服务 `src/lib/service/jev-requests.ts`：事务内回收超期预留→全局容量→共享退避/Key 冷却→最低负载选 Key→写预留，网络调用在事务外；`result_recorded_at` 保证真实结果只落账一次，`interrupted` 释放容量但允许迟到结果补写
- 连续三次实际失败禁用、成功清零；替换/手动恢复 generation+1 并清零计数；迟到/旧 generation 结果不改写新状态；429/529 写共享退避与 Key 冷却
- Worker：按执行槽 claim、租约覆盖 timeout+30s、owner 守卫（落判断/通知前 `isJobOwnedBy`）、`requeueJob` 用于容量/退避延后而不耗尽尝试次数
- 费用：整数纳美元估算（$0.042/Mtok 输入、输出免费），未知模型/provider/input 用量标未知；Jev 页新增 Key 管理与费用区
- 记录页：SQL `display_status` 单一 owner（含 job 失败未落 evaluations）、筛选先于分页、同一只读快照；六状态筛选、50 条分页、默认关闭的 5 秒刷新
- 前端：`api-resource.ts` 控制器（跳过重叠 tick、尾随刷新、旧 generation 不提交、dispose 中止）与 `apiGet` signal/no-store
- README 与 `.trellis/spec/{backend,frontend}` 同步新增契约

### Git Commits

| Hash | Message |
|------|---------|
| `04a269d` | feat: Jev 多密钥并发、费用统计与线报记录筛选刷新 |
| `347531a` | chore(task): archive 10-14-jev-key-pool-usage-records |

### Testing

- [OK] `pnpm lint` / `typecheck` / `test`（201 通过）/ `build`（`/api/*` 全动态）/ `docker compose config`
- [OK] 本地 HTTP 冒烟（mock 上游，无真实付费调用）：Key 掩码无明文、连续 3 次 401 自动禁用、禁用后测试返回 409 且不新增账本、恢复后计数回到 1、费用未知不显示为 $0、非法 `status` 返回中文 400
- [OK] 独立 trellis-check 核验 AC1—AC8；其提出的 2 个 P1（usage 非整数分页 500、按 Key 汇总把 in_flight 当已计价）已修复并回归
- [未验证] 真实浏览器点击（仅离线单测+代码阅读）、真实 Jev 凭据与真实账单、真正的多进程并发迁移

### Status

[OK] **Completed**（任务已归档到 `.trellis/tasks/archive/2026-10/`）

### Next Steps

- 需要真实凭据验收时：多 Key 并发与「连续 3 次失败禁用」在真实 Jev 环境复核；多 Key 是否共享账号额度官方未核实
- 自动按 Token 拆批（上游 64k/32k 上下文限制）留待确有需求且拿到可靠 tokenizer 时单独规划

## Session 3: 本地 Docker 环境升级上线（数据卷备份 → 重建镜像 → 启动核验）

**Date**: 2026-10-15
**Task**: （无 Trellis 任务，纯运维收尾）
**Branch**: `main`

### Summary

把已提交的多密钥/费用统计版本真正部署到本地 Docker：先备份数据卷，再重建镜像并启动 web/worker，核验 V2 迁移、旧密钥进入 Key 池、健康检查与新路由。升级前镜像与数据库都还是旧的（无任何容器运行）。

### Main Changes

- 备份数据卷 `11jev_xianbao-data` 到 `~/xianbao-backups/11jev-data-20261015-065111.tar.gz`（761K，`integrity_check: ok`，SHA256 已记录）；`.env` 未被读取或修改（备份动作被敏感路径策略拦截，APP_ENCRYPTION_KEY 保持原值）
- `docker compose up -d --build`：新版镜像 `ab9a20572187`（构建 52 秒），web `Up (healthy)`、worker `Up`
- 迁移核验：`schema_migrations` = [1,2]，新增 `jev_api_keys` / `jev_requests`；`secrets` 中旧 `jev.apiKey` 已迁为 `jev.key.legacy-default`，Key 池出现「旧版单密钥（迁移）」（enabled、generation 1）
- 路由核验：`/api/health` 200、`/login` 200、`/api/settings/jev` 与 `/api/settings/jev/usage` 未登录 401（新路由已生效）
- 数据核验：线报 1359 → 1578（持续采集），evaluations 1988 条保留完整

### 观测与结论

- 运行状态页仍显示「Jev 服务无法连接」是**升级前遗留**的 `lastError`（`lastErrorAt = 2026-10-14T14:51:33Z`），本次启动未产生新错误
- 调用账本为空属正常：两个需求（抽纸、至本卸妆膏）当前都是 `enabled=0`，判断任务按既有语义直接完成、不发起 Jev 调用（升级后 204 个任务 succeeded、attempts=0、0 条 evaluations）
- 启用需求后才会产生真实付费调用并写入费用区

### Status

[OK] **Completed**

### Next Steps

- 在网页按需重新启用需求；启用前费用区会显示「尚无调用记录 / 暂无可计价调用」
- 若需回退：`docker compose down` → 用上面的 tar 还原卷 → 以同一 `APP_ENCRYPTION_KEY` 启动旧版本
