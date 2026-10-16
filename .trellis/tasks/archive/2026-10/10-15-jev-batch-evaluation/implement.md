# 执行计划：JEV 三模式

状态：待最终方案批准。不得因本文件存在运行 task start 或写产品代码；用户尚需在规划摘要之后明确批准实施。

## 1. 奠基与上下文

- [ ] 读取 prd.md、design.md、implement/check.jsonl；确认三模式与全局规则，不带入旧稿的本地模型/缓存/硬条件方案。
- [ ] 按 AGENTS 和 Trellis 读取后台/前端规范；在写 Next 代码前读取 node_modules/next/dist/docs/ 中相关表单、route handler、server bundling 指南。
- [ ] 确认 git 工作区，保留非本任务的 AGENTS.md 等改动；不覆盖其他会话代码。

## 2. 领域、配置与迁移（R1/R5，AC1/AC2/AC9/AC11）

- [ ] 集中定义 EvaluationMode、处理 stage/来源、批次三态及客户端 DTO；不要在多文件复制枚举。
- [ ] 配置默认 individual，新增 regexRules，PUT 省略保留，空数组清空，非空规则数量/长度/体积/模式约束与中文错误。
- [ ] 明确保存预检事务外与版本冲突行为，保持普通旧客户端部分更新。
- [ ] 追加迁移：evaluation_runs、evaluation_batch_parts、bulletin_processing；扩展账本 run/part 关联与 purpose。迁移重跑/双进程及旧数据兼容。
- [ ] 完成原子 run/成员/part 创建、owner 守卫终态写入与幂等展开仓库，不在事务中 await。

## 3. 纯函数与正则隔离（R3/R4，AC6—AC8）

- [ ] 共用单条字段构造器，新增单问题门控构造/严格解析，criteria 表达 possible/uncertain 放行。
- [ ] 稳定装箱：20条、完整序列化16KiB启发保护；单成员/无法装箱走逐条，无正文截断。不实现不可靠的通用 tokenizer 或任意 HTTP400 二分。
- [ ] 全局规则 parser 保留非空 source 空格、精确去重、固定 iu；统一带标签匹配文本。
- [ ] 固定 .mjs worker 入口＋runner：ready/validate/match 协议、唯一 requestId、预算、超时 terminate、迟到结果拒绝、清理与单活跃线程。
- [ ] RegexRunner 可注入，语法/执行/协议/资源异常均 fallback；保存前预检复用 validate。

## 4. 统一调用服务和账本（R3/R5，AC4/AC5/AC10/AC11）

- [ ] batch_gate purpose/run/part 贯穿预留、结果、DTO和标签；不按成员倍增调用或费用。
- [ ] outcome 暴露实际非敏感连接配置标识；在统一服务记成功前验证门控响应，非法结果一次失败且保留 usage。
- [ ] 429/529、实际失败 Key 计数与未发送阻塞沿原规则，校验回调不导致二次计失败；旧单条/测试/试判语义不扩大修改。

## 5. 采集与两阶段调度（R2—R5，AC1/AC3—AC6/AC9）

- [ ] pollChannel 去重事务内按新模式保存 run/成员/子批并入队，baseline/空集合不进入；batch 需求快照、其他模式需求读取语义按设计。
- [ ] feed 返回后，在同一个 apply.immediate() 内读取模式/规则/version/批次需求并创建 run，不使用网络请求前的缓存。
- [ ] 统一 claim evaluate/screen_batch，继续共享 jobsPerRound/执行槽，不分开翻倍预算。
- [ ] 门控全否、放行、实际失败回退、not_sent 延后四条路径；只要放行就展开全成员，原 evaluate:<id> 幂等键保留。
- [ ] 正则逐条预筛、来源保存、后续模型重试跳过已成功预筛；执行异常不是 filtered。
- [ ] 默认路径与旧 payload 不加额外门控；模型/baseURL在门控期间变化时不得用旧否定结束成员。
- [ ] 每次 claim、失败/阻塞重排使用当前注入时钟；增加 owner 校验的租约校准，在真实 reserve 事务内按实际 timeoutMs 延长 job 租约。lease_lost 不发请求、不记真实调用，不可用轮开始时间或旧超时计算后续任务。
- [ ] 验证 crash 前后/失租/重复执行/需求删除与变更/旧 pending；通知只由逐条 matched 产生。

## 6. 页面与记录（R1/R5/R6，AC2/AC7/AC10—AC12）

- [ ] JEV 表单三选一＋条件展示全局多行规则，切走保留，保存回显；同现有 Apple 风格原语，不重做无关布局。
- [ ] 文案明确全批可疑/命中后全部逐条、规则漏报取舍、自动拆分、默认兼容与新采集生效；每轮任务数不冒充批次大小。
- [ ] 共享状态投影把合法 filtered 纳入 not_matched，详情注明批次/正则来源；不创建伪模型 confidence/evaluation。
- [ ] 批次/成员/请求可追溯，使用同一列表/详情/count快照；失败、待确认和未命中区分，刷新/筛选/分页保持。
- [ ] 测试/试判不受策略过滤，密钥掩码和同源鉴权保持；不新增价格比较模型、缓存或新服务。

## 7. 验证计划与审查

新增/扩展测试按模块覆盖上述验收，建议位置：

- tests/service/config.test.ts、配置路由契约测试：默认/部分更新/规则/冲突。
- tests/db/migrate.test.ts、tests/db/repos.test.ts 及新的处理仓库测试：迁移/原子展开/恢复/投影。
- tests/jev/batch-gate.test.ts、tests/service/regex-gate.test.ts、少量 worker_threads 集成测试：严格三态/装箱/隔离/超时。
- tests/service/jev-requests.test.ts、tests/service/jev-usage.test.ts：purpose、一次记账、Key与usage。
- tests/worker/pipeline.test.ts、evaluator-lease.test.ts、evaluator-concurrency.test.ts 及三模式集成测试：精确调用计数、全成员、阻塞/回退/旧队列/通知去重。
- 租约专项：同轮前一任务长耗时后的下一次领取、claim 后管理员增大超时、正则处理后按实际 reservation 校准、校准失去 owner 不发送，以及重排时间基于当前时钟。
- 原 dry-run/test、列表状态筛选与详情消费回归；页面人工检查键盘、窄屏、错误反馈和保存回显。

先跑受影响测试；最终一次完整质量门槛为：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] 额外执行无凭据 worker/容器路径烟测，确认 .mjs worker 文件实际可定位与启动，未意外真实采集或推送。
- [ ] 对生产 Next 构建产物使用隔离 DB 和本地鉴权启动，实际保存/验证正则，覆盖 .mjs 资源定位、ready、返回和退出；仅 pnpm build 或 tsx worker 烟测不算此项通过，不连接任何真实外部服务。
- [ ] 主代理最终核验 AC1—AC12 与 spec/跨层契约，不能以单测 mock 宣称真实 Jev 或 NAS 验收。
- [ ] 若校验暴露需要改变产品行为，回到规划；同语义实现修复可直接完成。

## 8. 上线与回退检查点

- [ ] 实施前需用户批准本轮最新规划摘要，再 task start；此项当前未满足。
- [ ] 迁移前备份 DB 和加密密钥；停旧 web/worker，避免混版本领取新任务 kind。
- [ ] 默认 individual 冒烟通过后才由管理员选择另外两种模式；保留旧队列及新run快照恢复证据。
- [ ] 回退代码需恢复匹配 DB，不能只切旧镜像；不在本任务自动部署或发送真实通知。
- [ ] 按 Trellis 完成 spec判断、提交计划及收尾；不提交其他会话的 AGENTS.md 改动。

## 本轮规划验证

本轮只验证文档、上下文引用与任务状态，没有写产品代码或执行上述 pnpm 质量门槛；这些命令是实施阶段要求，不应报告为已经通过。
