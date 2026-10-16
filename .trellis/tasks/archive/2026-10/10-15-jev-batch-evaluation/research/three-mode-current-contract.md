# 三模式当前契约与技术待核实项

日期：2026-10-16。两个只读探子分别核查最新 UI/API 和队列，主代理点验配置读写、表单及接口 schema。未改产品代码、未运行测试或模型请求。

## UI 与配置

- src/lib/service/config.ts:117 配置类型；163 默认读取；221 逐字段保存；256 同步事务保存。候选 evaluationMode 枚举 individual/batch_gate/regex_gate；旧值缺失默认 individual，PUT 省略保留旧值。
- src/app/api/settings/jev/route.ts:20 PUT schema，58 显式传递；src/components/api-types.ts:47 DTO 必须一致。
- src/app/(admin)/jev/page.tsx:41 JevForm，57 PUT，129 每轮任务文案，136 单请求全需求说明，654 表单分区，677 version key。沿现有 Apple 风格表单扩展，不重做整页。
- 用户已确认全局规则，放 settings JSON，不扩展 needs CRUD；选 regex_gate 时显示编辑，切走保留规则，启用时须有合法规则。此决定优先于前期按需求备选讨论。
- 测试 src/app/api/settings/jev/test/route.ts:36，试判 src/lib/service/dry-run.ts:64—88。策略放自动调度层，避免工具调用被过滤。

## 批次和恢复

- src/lib/worker/collector.ts:180 feed limit 50，199—225 为去重插入与入队事务。推荐同事务持久化一次单频道新增非基线集合，不建空批。
- src/lib/domain/types.ts:18、21 的 JobKind 与状态；src/lib/db/migrations.ts:120 的 kind 为 TEXT，但 evaluator:209、216、273 固定解析单 bulletinId，需显式批次入口。
- jobs 的 UNIQUE(payload_key) 为全生命周期唯一（migrations.ts:134），不能重插 succeeded 同键期待重跑。旧 pending 没有原 feed 集合，保持旧逐条路径。
- 候选阶段：初筛等待→全否终态，或展开等待→全部成员任务已生成；拆分保存父子关系。owner 校验、结果、展开任务和阶段前移同事务，避免重启漏展开或重复。
- 不在一个 gate job 内串行跑 N 次精判，避免超过现有 timeout+30s 租约；成员独立任务沿现有逐槽领取。

## 快照、账本和状态

- evaluator:85、90 每次读实时 needs/config；service/jev-requests.ts:127、220 预留又读实时配置。settings 覆盖旧值但无历史正文（db/repos/settings.ts:43—65），策略/规则/需求需保存可还原快照，不能仅存版本号。
- 模型/服务连接配置变化的失效策略需与 Key 健康、容量实时状态区分，不冻结旧 Key 可用性绕过人工停用与限流。
- migrations.ts:218 和 service/jev-requests.ts:285 当前仅单 bulletin/job 关联；需批次/子批/阶段追溯，仍一次真实请求一行，门控不按成员倍增费用或 Key 失败。
- service/jev-requests.ts:366 先记 succeeded，evaluator:120 后解析答案；门控非法答案与 Key 健康如何分类须明确，避免重复计失败。现 evaluator:150、175、228 的逐题 failed 后 complete 不能直接照搬为门控结束。
- jev/prompt.ts:16 的 criteria 绑定现三态；门控可同三态但用独立 criteria，或独立类型，禁止缺答/未知当全否。
- db/repos/bulletins.ts:177—197 依赖 evaluations 与 evaluate:<id>。过滤终态需同步列表/筛选/详情，明确来源，避免永久 pending 或冒充逐条模型结论。具体独立筛选表或来源字段待设计。

## 技术未决，不能当已验证

1. 当前无 tokenizer。字符/字节只能是启发值，不能冒充精确 Token；须研究可靠预算和明确上下文超限信号。
2. jev/client.ts:175—192 非 2xx 未保留足够错误结构区分上下文错误；不能见任意 400/413 就二分，也不能把原始错误直接暴露。
3. 正则语法/flags、编译验证和执行资源边界，非法保存与执行异常回退规则；合法语法不能保证不会耗尽 CPU。
4. 批次/成员/快照迁移、旧 payload 兼容、记录投影和调用关联。

全局归属已确定，正式契约以 prd.md、design.md、implement.md 为准。该文件提供当前代码定位，不替代设计；任务保持 planning，尚待用户批准最终摘要。
