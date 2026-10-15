# 技术设计：Jev Key 池、调用账本与记录页

## 1 范围与模块边界

以本任务 PRD R1—R4 / AC1—AC8 为产品契约；当前事实见 research/current-behavior.md，价格见 research/pricing-models.md。沿用 Next.js、同步 SQLite、Zod、pnpm 与独立 worker，不新增外部服务。

所有实际 Jev 请求通过统一服务（建议 `src/lib/service/jev-requests.ts`），负责 Key 选择/容量、调用生命周期、失败计数和用量账本；HTTP 适配器 `src/lib/jev/client.ts` 只负责传输和响应边界，prompt.ts 继续构造/解析独立需求。网页只读 API DTO，不能导入数据库或明文凭据模块。

生产 evaluator、连接测试、需求试判均接入该统一服务。保留依赖注入 fetchImpl/callSystemOne/now，测试不连接真实服务。连接测试异常在服务完成账本/计数更新之后再转换为中文结果，不能先吞错丢掉错误分类。

## 2 存储、升级与原子性

追加 V2 增量迁移，保留 V1。迁移 runner 必须在 BEGIN IMMEDIATE 事务内读取已应用版本，不能使用事务外快照；web/worker 两个新进程同时启动时 V2 只执行一次，两个调用都成功。这是对 `src/lib/db/migrate.ts:21–35` 已点验竞态的修正：

- `jev_api_keys`：id、label、secret_namespace、generation、enabled、disabled_reason、consecutive_failures、last_error、last_used_at、cooldown_until、created_at、updated_at。布尔值绑定为 0/1；唯一 secret_namespace；错误仅存清洗后中文信息。
- `jev_requests`：本地 id、upstream_request_id（可空）、key_id（可空）、key_generation、purpose（evaluate/test/dry_run）、bulletin_id/job_id（可空）、requested_model、response_model、provider_origin、config_version、status（in_flight/succeeded/failed/interrupted）、started_at、finished_at、lease_until、result_recorded_at（真实结果完成标记，可空）、http_status/error_code/error_message、input_tokens/output_tokens（可空）、price_version/input_rate、estimated_usd_nanos（可空）、cost_status（known/unknown）、unknown_reason。Key 删除不级联删除账本，可保留非敏感 id/label 快照。
- 状态与时间/Key 查询索引支持调度、聚合、最近调用；每个本地 request id 唯一。真实结果完成按 `result_recorded_at IS NULL AND status IN ('in_flight','interrupted')` 原子更新并设置 result_recorded_at，允许租约回收后迟到结果更新原账本一次，防止重复累计。

旧 `secrets('jev.apiKey')` 在迁移事务中原样搬到固定的兼容 Key namespace，插入一个默认启用的旧 Key 元数据后清除旧 namespace。不解密重加密，不读取真实密钥到迁移日志。无旧 Key 不创建空条目，重复迁移不重复创建。设置仍保留原 baseUrl/model/timeout/concurrency/jobsPerRound。

Key 新增/替换/清除、metadata 与 encrypted secret 更新用同一 SQLite 事务；替换/手动重新启用重置计数并增加 generation。config.version 同事务自增。只更新普通 Jev 配置不能重置 Key 计数或误启用已禁用 Key。

账本不能还原统计启用前费用。调用开始即写 in_flight；进程中断后过期项变为 interrupted/未知费用，不伪造零账单，也不凭没有响应判定认证失败。interrupted 释放的是容量预留，不等于已有真实结果：迟到响应可将原行转为 succeeded/failed，原子更新真实用量与当前 generation 的健康计数一次；没有迟到结果时永久保持未知。健康计数与账本结果在同一事务写入，已禁用 Key 的计数/状态保持锁定直到恢复，不能因迟到成功清零。外部平台可能已收取未知用量，本地唯一键只防止重复记同一次调用，不能实现外部 exactly-once。

## 3 Key 调度、容量与三次失败

一次 BEGIN IMMEDIATE 事务：回收过期 request 预留，读取当前配置与启用/可解密且非 cooldown Key，检查所有入口的有效 in_flight 总数小于配置 concurrency，再按在途数最少、last_used_at 最旧、id 稳定排序选择 Key，插入 request 预留并更新 last_used_at。不得在事务内 await 网络。

保留单 Key 已有并发能力：同一 Key 可以服务多个在途请求；多 Key 优先均匀分配。全局并发默认仍 1、范围 1—8，开启两个同时在途至少需设为 2。不新增「每 Key 并发 × Key 数」语义。生产/测试/试判共用持久化容量，web 和 worker 不会各自超额分配。

- 容量暂满/退避中：不发请求，不记失败，不记录付费调用。worker 保留/延后任务；测试/试判返回中文稍后重试提示。
- 无可用 Key：明确配置问题，worker 不耗尽任务普通重试次数；恢复 Key 后队列继续。
- 实际请求成功：按完成顺序将当前 generation 的计数置 0；结构及预期问题答案有效才视为成功，matched/not_matched/uncertain 均是成功判断。
- 实际失败：当前 generation 计数加 1，达到 3 时原子 enabled=0、记录自动禁用原因。网络/超时、所有非 2xx、非法 JSON/响应/预期答案均计入；一次多问题请求最多计一次失败。合法的部分答案保持当前逐需求处理语义，非法项仍是 failed，不伪造命中。
- 达阈值后不再分配新请求；已在途请求继续完成/记费用，但迟到成功不能改变 enabled 或抹掉禁用原因。替换/恢复前的旧 generation 结果只能写自己的账本，不影响新 generation。
- 人工禁用同样不能被结果重新启用。删除/清除 Key 后终态更新不依赖 Key 行存在。
- 429/529 计入失败并解析 Retry-After；同一 provider 池持久化共享退避截止时间（可存 settings 独立 namespace），避免轮换 Key 绕过可能共享的限额。优先服务端等待时间，否则有限指数退避；不使用官方动态 80 RPS 作为固定并发阈值。

密钥解密失败是本地配置错误，网页返回 unreadable，不能发请求；不把它计作已发上游失败。

## 4 Worker 租约与结果提交

保留 jobsPerRound 每轮处理量上限，但按执行槽实际要处理时 claim，不能一开始领取整个等待队列，让未开始的任务耗租约。claim 租约至少覆盖配置 timeoutMs 加收尾余量（例如 30 秒），调用 request lease 同样覆盖超时，必要时用已注入时钟续租。

每次 claim 有独立 owner/token；成功、失败与判断/通知事务提交必须检查仍为该次 leased owner，失去 ownership 的结果不能覆盖新 owner。容量预留租约、job ownership 和真实请求结果完成是独立条件：另一连接回收 job/request 后，旧调用真实响应仍更新自己的账本与同 generation 健康计数，但不能落判断/通知。保持 notification 唯一和 delivery 成功不可重放语义。

处理网络错误时根据 retryable、Retry-After 和 Key 池状态分类；Key 禁用后未成功的线报留待其他 Key 的后续任务重试，不在同一包装器内隐式连发多次。配置/容量问题永久可恢复、普通失败有限退避、不可重试非法输入明确失败。全池不可用不能显示成没有匹配。

## 5 请求合并与输入上限

维持一条线报所有启用需求一个 state + 多个独立 Choice 问题，稳定 question ID 到需求快照映射。抽纸与卸妆膏共享正文，绝不能合并成只返回一个品类的互斥问题，不能用品牌/关键词预筛省掉语义判断。

官方上限 64k state+全部 questions、32k state+最长单题；暂未核实官方 tokenizer。保留完整内容，不按字符裁剪冒充精确 Token 上限，不引入猜测分批算法。上游上下文超限作为明确不可重试请求失败显示，记一次 Key 失败、若响应未报用量则费用未知。自动按 Token 拆批留待确有大需求负载和可靠 tokenizer 时的独立改进；本期两需求例子必须只请求一次。

## 6 用量与美元估算

适配器校验 usage.input_tokens/output_tokens 为有限非负安全整数；缺失/null/类型非法均按该项未知处理，用量缺失不能使合法判断失败。读取 `x-typesafe-request-id` 响应头和响应 model；即使后续答案解析失败，也保留已报告用量。非 2xx 仅从明确符合 usage 契约的字段读取，其他正文不能冒充用量。

固定首个已核验价格版本：2026-10-14，官方 api.typesafe.ai 的 `jev-1.13.0` 输入 $0.042/Mtok，输出免费；请求时间和响应模型决定价格。`jev-latest` 仅在响应确认为该版本时可按此费率计价。未知模型、自定义 provider、缺响应模型/用量无法核实时标未知，不套用已知费率。价格通过版本化费率模块管理，更新模块新增价格版本，不重新计算历史行。

金额用整数纳美元保存：当前每输入 Token 42 纳美元，1,000,000 input tokens -> 42,000,000 纳美元 -> $0.042。安全整数/BigInt边界在仓库处校验，展示按美元合理小数位，不能把很小正数显示成 $0.00。output_tokens 仅供查看，不增加当前版本费用；缓存价未核实，不宣称缓存优惠。

费用区展示：统计开始时间、已知累计估算美元、输入/输出 Token（注明已知用量）、实际调用数、失败次数、未知费用调用数；按 Key 汇总与最近调用详情（时间、来源、模型、状态、用量、估算或未知原因）。未知项目数量与已知金额同时显示，不能把不完整汇总标为全部账单。连接测试、试判和每次实际重试都算调用；没有请求/仅重放本地结果不计费。

## 7 API 与网页契约

- 继续 `/api/settings/jev` GET/PUT 非敏感基础配置；GET 增加 keys 列表，每项仅 id/label/generation/secretState/enabled/disableReason/consecutiveFailures/lastError/lastUsedAt。客户端类型集中 api-types.ts。
- 新增 `/api/settings/jev/keys` POST 添加、`/api/settings/jev/keys/[id]` PATCH 修改 label/enabled/replace-or-clear 与 DELETE 清除；采用现有 SecretInput 保留/替换/清除语义。手动恢复是显式 enabled:true，清零并进入新 generation。
- 存量单 apiKey 字段由兼容层映射到迁移 Key；明确 clear 只清除该兼容 Key，不清整个池。新页面只使用多 Key 接口。
- `/api/settings/jev/test` 可选 keyId，指定 Key 做单次测试；已禁用 Key 必须先显式恢复才能测试，不隐式启用。未指定 Key 与试判使用池调度。
- 新增 `/api/settings/jev/usage` GET 返回美元汇总、按 Key 汇总和最近请求，分页默认最近 20 次、支持 limit/offset 与正确 total。生产/测试/试判仅返回清洗后的内容，不返回 raw 密钥、Authorization 或上游敏感正文。
- 所有读取鉴权；所有写入 requireAuth + requireSameOrigin；非法字段中文 INVALID_BODY，保留项目 `{ok,data/error}`。

Jev 页面新增 Key 管理区（添加、重命名、替换/清除、启停/恢复、单 Key 测试、失败计数/禁用原因）与费用区，保留模型/URL/超时/全局并发/每轮任务/需求试判；帮助文案说明全局并发和连续三次失败。

## 8 状态筛选与轮询

API 接受 status = pending/matched/uncertain/failed/not_matched，缺省即全部；非法枚举400。保持 baseline:false 与 sourceNs/limit/offset。SQL 在分页前计算共享 display_status CASE，items/count/detail 使用相同表达式或同一个仓库投影函数，不复制 TS 与 SQL 两套优先级。列表 count、页记录及返回的判断/投递/通知投影在同一同步只读事务/数据库快照内读取，不因另一进程中途完成判断而返回互不一致的 total/items/status。

优先级维持 baseline > 任一 matched > 任一 failed > 任一 uncertain > 存在其他判断 > pending；在没有匹配结果的前提下，evaluate job dead 或 last_error 非空同样为 failed（失败未落 evaluations 也可筛到）。成功重试清除 job.last_error 后恢复正确状态。所有未命中状态必须与处理失败区分。列表保持发布时间/创建时间倒序，加 id 稳定兜底；50 条一页，筛选切换回第一页，增加简单上一页/下一页。

记录页自动刷新默认关闭，明确按钮「自动刷新：开启/关闭（5 秒）」；开启每 5000ms 触发，慢请求跳过重叠 tick，不积压；筛选/分页变化立即取新数据，刷新保留筛选与页码。total 缩减使当前页越界时归到有效页。

扩展现有 useApiResource + apiGet 的 signal/no-store/request-generation 支持：定时 tick 在同查询请求在途时跳过；手动/写入后 reload 必须保证至少发起一次在该次 reload 调用之后启动的新请求，可顺序排一个尾随刷新并等待它，不能只合并到保存之前的旧 GET。不叠加同查询请求；旧 GET 在等待尾随刷新时不提交过时数据。路径改变 abort 旧请求，旧 generation 不 setState，离页清理定时器/请求。data/error/loading 关联所属 path/generation；同查询刷新失败可保留既有列表，新查询加载或失败必须隐藏旧查询列表。401 继续跳登录并显示错误。共享 hook 的频道30秒/状态15秒刷新以及需求/Jev等保存后的 reload 都必须回归。

## 9 运维、风险与回退

升级前备份 SQLite 和 APP_ENCRYPTION_KEY，停止旧 web/worker 再迁移/启动，避免旧进程继续使用已迁移 namespace。回退到旧代码需恢复与之匹配的数据库备份，不能仅回退镜像。

平台临时故障也计连续失败，可能导致全池禁用，网页提供明确恢复入口；多个 Key 是否共享余额/配额未核实，不承诺倍增吞吐。日志与费用账本不存明文密钥，长期调用表保留策略本期不新增自动删除。产品代码实施前必须得到本次完整方案的后续批准。
