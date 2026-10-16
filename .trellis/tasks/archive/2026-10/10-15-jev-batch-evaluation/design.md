# JEV 三模式技术设计

状态：规划待审，未实施。产品契约为 prd.md R1—R6/AC1—AC12；2026-10-16 用户已选择全局正则。此前模型、缓存或硬条件探索不是本轮范围。

## 1. 模块边界

- 配置：沿用 settings('jev') JSON 与版本，新增 evaluationMode 和 regexRules；不另建配置页面。
- 采集：一次单频道 feed 成功后的新增、去重、非基线集合形成处理 run；只保存快照及队列，不在采集事务内调用模型或执行正则。
- 调度：evaluator 按统一轮预算领取 evaluate 或 screen_batch；门控展开后成员分别领取，不能在一次门控租约内串行请求全批。
- JEV：单条 prompt 保留，新增单个批次相关性 Choice；所有真实调用仍经 callJevWithLedger。策略判断不放进统一 transport 层，测试/试判不被预筛。
- 正则：纯规则解析/文本构造与独立 Node worker runner 分开；数据库、密钥与网络不传入正则线程。
- 记录：本地处理状态独立于模型 evaluations，来源可追溯，详情不把本地过滤伪装成逐条模型回答。

## 2. 配置与网页契约

候选字段固定为 evaluationMode: individual | batch_gate | regex_gate，regexRules: string[]。

- GET：字段缺失或 mode 非法时默认 individual；规则结构异常不得形成全量过滤，后台走异常回退并记录中文原因。
- PUT：字段可选，省略保持旧值；regexRules:[] 显式清空。有效模式为 regex_gate 时必须有至少一条合法规则；在其他模式可保存空规则。
- 原始表单一行一条 source，不接受 /pattern/flags 包装或自定义 flags；固定 iu。纯空白行忽略，非空行保留空格，精确去重且保留顺序；服务端验证 20 条/每条 500 UTF-16 单元/合计 16 KiB 上限。
- 全部模式均校验提交的规则；切换后隐藏编辑器但不清除已保存内容。错误指出第几条规则，保持中文字段错误与现有 API envelope。
- 编译预检在线程中、事务外完成；进入保存事务时重新核对候选所基于的配置版本，若并发修改则 409 提示刷新重试，不把旧校验应用到新规则；事务内不 await。只有涉及规则/启用模式的提交需要异步规则校验，普通旧客户端部分更新保持原有保留语义。
- 沿 keyed JevForm、Section、Feedback 与现有数据 hook 增量扩展；保存成功刷新，不用 effect 镜像 props。
- 模式选择帮助：逐条保持完整语义判断；批次全部无关时省调用，有命中/可疑则增加一次预筛；正则可能因规则未覆盖漏报。没有额外确认弹窗。
- 每轮任务数文案改为判断任务预算，批次初筛也算一个调度任务；它不是批次条数。全局并发仍约束实际请求，Key 数不放大并发。

## 3. 增量数据模型

追加新迁移版本，不修改已应用的 V1/V2。新表/列由 migrations.ts 唯一拥有，仓库读写统一，布尔值仍绑定 0/1。具体索引名可按仓库命名习惯落地，但以下字段语义与唯一性不变。

### evaluation_runs

- id、source_ns、evaluation_mode、strategy_config_version、regex_rules_json、need_snapshots_json（可空）、created_at。
- 保存采集时的模式及全局规则。batch_gate 保存该次全部启用需求的 id/name/note/enabled/version 快照；individual/regex_gate 不冻结需求清单，逐条调用继续按现有执行时需求语义，避免默认模式行为漂移。
- 需求快照不是对 secrets 或 Key 可用性的快照，不复制明文凭据。

### evaluation_batch_parts

- id、run_id、ordinal、state（pending/excluded/expanded）、gate_result（可空）、gate_request_id（可空）、fallback_reason（可空）、created_at、updated_at。
- UNIQUE(run_id, ordinal)。仅 batch_gate 使用；完整成员由下表关联。子批划分在采集事务内完成，顺序稳定，重启不重新随意分组。
- 门控结果只能有一个终态；owner 守卫及 state=pending 条件防止迟到门控再次排除/展开。

### bulletin_processing

- bulletin_id PRIMARY KEY、run_id、batch_part_id（可空）、position、stage（pending/ready/filtered/evaluated/failed/skipped_no_needs）、screening_source（可空）、screening_reason（可空）、gate_request_id（可空）、matched_rule_index（可空）、created_at、updated_at。
- 一个新增来源 bulletin 对应一条处理记录。索引 run_id、batch_part_id 和 stage，便于批次查询、状态投影与恢复。
- filtered 只代表合法批次全否或合法正则全 false；不创建伪造的逐需求 evaluation。批次概率仅保留在门控证据，不复制为成员置信度。
- 无启用需求沿用不请求模型的行为，不把“没有需求”当作明确未命中；可保存 skipped_no_needs 原因，不自动回放。

### jev_requests 扩展

- 新增 evaluation_run_id、batch_part_id 可空列和相应查询索引；旧账本行保持 null，不回算费用。
- purpose 新增 batch_gate；单条仍 evaluate，测试仍 test/dry_run。逐条有 bulletin_id，门控没有单个 bulletin_id，通过 part 关联成员。
- 每次真实调用一行，重试另行记账，正则/本地装箱不记请求。账本 DTO、purpose 标签、汇总查询同步新增值。
- 表关联遵循不自动删除旧来源/账本的现有保留策略。新增结构仅服务三模式，不引入缓存或跨文章合并。

## 4. 采集、快照与队列

一次 pollChannel 事务内：去重插入 bulletin → 收集 inserted 且非 baseline 的成员 → 保存 run/processing → 按模式建立任务。空集合不建 run；首次基线不入本流程。

| 模式 | 采集事务中的任务 |
| --- | --- |
| individual | 沿 evaluate:<bulletinId> 建逐条任务，payload 增加可选 evaluationRunId |
| regex_gate | 同样建逐条任务，但先按 run 的规则快照筛选 |
| batch_gate | 按预算建立 part 与 screen_batch:<partId>；单成员或无法装箱的成员直接建 evaluate:<id>，不发无效门控 |

evaluator 用一个原子 claim 查询同时覆盖 evaluate/screen_batch，按现有 run_at 稳定顺序领取；共享 jobsPerRound 与执行槽，不分别启动两套可能翻倍的预算。扩展 JobKind，保持既有 job 状态、claim owner、续期/回收契约。

采集快照的读取也必须发生于去重/建 run 的同一个 apply.immediate() 事务：在 feed 网络请求返回后同时读取模式、规则、配置版本及批次需求，不沿用请求前或整轮缓存。这样保存配置与新 run 创建之间有明确的事务先后关系。

现有 evaluator 在整轮开始固定 now/timeout，并把它们用于后续 claim；这不构成可靠续租。本次必须增加：每次 claim 用注入时钟的当前时间；失败/阻塞重排也用处理当时的时间，不能沿用已过时的整轮时间。claim 初始租约至少覆盖预筛最大耗时和调用超时再加 30 秒余量。

实际 reserve 时可携带受信任的 jobId/owner。在容量预留事务内，用该次真正选定的 timeoutMs 计算请求 deadline，并以 owner/status/未过期条件校准 job.lease_until 至不早于当前时间+实际 timeoutMs+30秒，再写请求预留；校准失败则不发请求、不记真实调用，返回 lease_lost 类型的本地阻塞。测试/试判无 job owner 时不走该校准路径。不能在请求已发出后才发现 claim 使用了旧超时；长耗时任务之后的下一次 claim 也不能用旧 now。继续保留落业务状态前的 owner 守卫，不能用续租替代它。

旧 payload 没有 runId 时走原逐条路径。已有 succeeded/dead 不因升级重新插队；旧 pending 不按时间猜造采集批次。模式/规则变更只作用于之后新采集 run，旧快照继续完成。已启用正则的 run 也不会因为之后切到 individual 而更换规则。

批次需求在采集时冻结，门控和展开都使用它；individual/regex_gate 继续执行时取启用需求。删除需求不影响已保存快照，现 evaluations 无 need 外键，可保留历史名称/备注。界面说明快照与当前需求可能不同，不自动回放历史。

## 5. 批次初筛与输入预算

### 保守装箱

- 固定内部初始保护值：每子批最多 20 条，完整门控请求（含全部成员正文、需求说明、criteria 与序列化开销）UTF-8 体积不超过 16 KiB。
- 两者是工程保护值，不是官方 Token 等价换算或精确 32k 上限。官方未公开可核实的预计算 tokenizer，不引入通用 tiktoken 假装精确计数。
- 稳定顺序贪心分组，加入下一成员超阈值则封组；单成员连同完整问题都过阈值则直接逐条，不截断正文。只有一条的子批直接逐条，避免额外门控请求。
- 分组时使用与实际门控完全相同的序列化构造器。服务 model 字符串等变化后若体积再次过阈值，按全成员逐条回退，不在请求体里偷偷删数据。
- 官方上下文规则仍是 state+最长题 32k、state+全部题 64k。若实际仍超限，作为一次门控失败落账并转逐条；不依赖尚未核实的错误字段路径，不把任意 400/413 当成可二分信号。

### 一个问题与三态

新增 buildBatchGateRequest/parseBatchGateResponse，单问题 ID 为 batch_relevance。state 包含稳定成员 ID 与完整现有字段，问题 instructions 包含全部需求名称/备注，不依赖 ID 传递语义。

- matched：至少一条明确符合任一需求。
- uncertain：存在可能相关或信息不足，或无法明确排除任何成员/约束。
- not_matched：能明确确认全部成员对全部需求均不匹配。

matched/uncertain 均展开所有成员。只有经过结构与预期 question ID 校验的 not_matched 才允许整批结束。多成员合成判断仍可能有语义假阴性，这正是可选模式需提示的取舍，不把置信度当业务准确率，也不新增无依据阈值。

### 落库与恢复

- 门控任务一次只发一个上游请求。not_sent 的 busy/cooldown/no_key 等按现有持久化阻塞机制延后，part 仍 pending，不展开绕限流。
- 实际请求失败、缺题/非法、超时或输入越界：记录门控失败及原因，将 part 展开为全成员逐条任务，成员失败沿现有逐条重试。429/529 即使展开也继续服从共享 cooldown。
- 合法全否：在一次 owner 校验事务中保存 part excluded、各成员 filtered、gate_request_id 并完成任务。
- 放行/回退：同一事务保存 part expanded、成员 ready、幂等建立 evaluate:<id>、完成门控 job。重复执行看到终态只幂等完成，不重复生成任务。
- crash 在事务前可重试门控；事务后已有终态和成员任务。失去门控 owner 的迟到请求仍记录真实用量/Key 状态，但不能改变 part 或成员。

## 6. 模型配置与统一调用服务

- 策略/规则是 run 快照；batch_gate 的需求也是 run 快照。服务地址、model、超时与 Key 调度仍由统一服务实际预留读取，Key 健康与容量永远实时。
- 成功/失败 outcome 增加非敏感实际语义配置标识（标准化 baseUrl/model/configVersion），从 reservation 生成，避免 evaluator 猜测调用配置。现有 requestId 继续用于证据关联。
- 门控返回与提交之间若 baseUrl/model 已变化，不采用旧连接的否定作最终结果，转全批逐条；普通并发/超时/Key 元数据变化不因 version 自增就误判语义变化。之后再改配置不自动回放已有终态。
- 允许仅供受信服务端调用的响应校验回调/等效 gate 校验路径：在统一服务记录成功前验证门控完整性。非法答案按实际调用失败计一次，保留 response usage/model/request id，再回退逐条；不能事后再补记失败造成 Key 双计。
- 门控业务校验仅针对新增 purpose，不借本轮修复所有旧逐题解析语义。测试/试判与现有逐条行为继续保持，所有入口仍共享同一容量和账本。
- 不把规则模式、批次模式放进 callSystemOne transport，避免测试/试判被过滤。

## 7. 全局正则执行

### 规则和匹配文本

固定 iu，无 g/y 可变 lastIndex。最多 20 条、每条 500 UTF-16 单元、总规则 16 KiB；忽略空白行、精确去重，保留非空 source 中的空格。界面示例使用 source（如 抽纸|软抽），明确不带首尾 /。

按固定顺序拼接带中文标签的标题、正文、品类、品牌、商城、来源价格；缺失字段省略，数值只按现有来源值作为文本，不宣称券后实付。文本与字段顺序由一个构造器拥有，测试覆盖跨字段与换行行为。

任一规则 true 即 pass；全部合法规则都完成且 false 才 filtered。规则为空、输入超过边界、协议不完整、编译/执行/线程错误都为 fallback，不能用“没得到 true”当 false。

### Node worker_threads

- 固定 .mjs 线程入口，execArgv:[]，由现有 Node>=22/tsx 主程序调用；不要求在 worker 中加载 tsx。
- 同一 runner 还会被生产 Next PUT 路由用于保存预检，不能只验证 tsx 后台入口；构建产物必须保留/定位 .mjs 资源，并在生产 Next 服务实际执行 validate、ready 和退出生命周期。
- 固定脚本经 workerData/消息收普通规则和文本，不拼接用户代码，不使用用户提供的 eval。一个后台进程最多一个活跃正则线程，可按规则快照复用编译缓存。
- 默认技术预算：启动至显式 ready 2 秒；派发后每命令编译＋匹配合计 500ms；等待空闲最多 100ms。单条文本最多 64 Ki UTF-16 单元，单命令总输入最多 512 Ki；超限整体回退，不截断后据未命中过滤。
- resourceLimits 建议 old 32MiB/young 8MiB/stack 4MiB；它不是 CPU 硬限制或进程总内存保证。父线程负责超时，不能靠被同步 RegExp 阻塞的 worker 内定时器。
- 超时先结算 fallback 再 terminate；requestId/规则签名/成员集合校验防迟到结果反转。终止异步，旧线程退出前不堆叠新线程；无法退出时暂停正则执行并继续逐条回退。
- 保存预检使用同一 runner 的 validate 命令，在事务外完成；进程退出清理线程、事件监听器和定时器。Next.js 打包、Docker 与 worker 启动路径需要真实构建验证，不只单测。

### 逐条任务行为

regex_gate 的 evaluate job 先读取 run 规则快照。pass/fallback 持久化为 ready，再走原逐条 JEV；后续网络重试不重复跑正则。filtered 在持有 owner 的事务中保存来源/原因并完成 job，不写伪 evaluations。实际模型失败仍有原重试，不因过滤模式无限重判。

## 8. API 与记录投影

- 列表现有状态枚举继续使用，过滤结果纳入 not_matched 筛选，但提供 processing 元数据与独立显示来源：逐条判断、批次预筛排除、正则过滤。
- 共享 CASE/只读快照优先级保持 baseline→matched→failed→uncertain→已有模型判断的 not_matched；无逐条 evaluation 且 processing.filtered 时为 not_matched；其余 pending。已有匹配不能被处理元数据覆盖。
- gate 阻塞/失败但未展开时，成员应能查询该 screen_batch job 的当前错误；已完成 fallback/expanded 的门控失败仅作为历史原因，不能永远遮住后来成功的成员状态。
- 详情显示策略、规则/需求快照、批次及 request 关联。批次排除说明“由批次预筛判定，未进行逐条 JEV 判断”；正则排除说明“规则未匹配，未调用 JEV”。不显示虚构概率或模型理由。
- page/filter/count/detail 统一仓库投影，同步 api-types 标签和页面。保留原五秒刷新、查询取消、分页和鉴权行为。

## 9. 测试与质量门槛

实现前读取相关 node_modules/next/dist/docs/ 指南，遵守新版 Next API；本轮规划未写 Next 代码。实现阶段必须通过 pnpm lint、pnpm typecheck、pnpm test、pnpm build。

- 默认/存量/部分更新、规则 OR/空/非法/保留、版本冲突、持久化配置。
- 三模式精确调用数、需求问题数、初筛三态、非法/超时回退、429/cooldown 与 no_key 未发送阻塞。
- UTF-8 预算边界、中文/长正文、稳定分组、单成员 bypass；不遗漏或截断。
- 正则 fake runner：pass/filtered/fallback、超时/迟到、错误协议、失租；少量真实线程测试验证 ready、可终止灾难回溯、清理，不依赖毫秒级吞吐断言。
- 门控落库/展开/重启、旧 pending、采集基线、需求删除/修改、连接语义变更、旧 owner、通知幂等及账本一次计费。
- 同一轮前一任务耗时很久后再领取、claim 后配置增大 timeoutMs、正则预筛后实际 reserve 校准、失租前拒发请求和重排时间使用当前时钟。
- 列表总数/分页/详情来源与失败区分，测试/试判在所有模式仍直接调用。
- 所有模型调用注入 transport，测试离线；部署烟测不携带真实采集/模型密钥，不产生通知。
- 生产 Next 构建后用隔离数据目录启动，只验证保存正则规则的本地 validate 路径；不启动采集、不连接模型或通知。tsx 后台线程烟测与 Next 端验收两者都要覆盖。

## 10. 上线、回退与证据限制

用户批准最终规划后才能 task start。代码实现与质量通过后再按项目流程审阅提交，不在规划轮启动实施。

升级前备份 SQLite 与加密密钥，停旧 worker/web后运行迁移，避免旧进程处理新 kind。默认 individual，先验证存量行为，再由管理员显式选择可选模式。切回 individual 只影响新 run，旧快照继续恢复；若必须立即停止旧批次，须明确运维方案，不自动丢弃队列。

回退旧镜像需要匹配的 DB 备份；新增表/列与新 kind 不能承诺旧代码理解。未做真实 JEV 付费调用、NAS 部署或性能验收，不承诺固定节省比例。16KiB、20条、线程超时和内存预算均为起始保护配置，实施测试可在不改变产品语义前提下调整，并记录依据；如需改变可观察行为则回到规划。
