# 当前实现核查（2026-10-14）

本文件压缩三路只读探子的源码与官方文档核验结论。主代理点验了 evaluator 请求构造、记录页刷新与 Jev HTTP 错误处理，以及官方模型和响应原文；未执行真实 Jev 请求、通知或产品修改。

## 请求与并发

- `src/lib/db/repos/needs.ts:41` 的 listEnabledNeeds 获取全部启用需求；`src/lib/jev/prompt.ts:27,56` 构造稳定 `need_<needId>` questions；`src/lib/worker/evaluator.ts:76–115` 一次 call 携带整个 questions 后逐需求解析落库。
- 需求试判 `src/lib/service/dry-run.ts:79–102` 同样一次请求。没有批处理问题数上限或请求上下文检查。
- `src/lib/service/config.ts:118–123` 当前 concurrency 1—8 / 默认 1；jobsPerRound 1—50 / 默认 3。
- `src/lib/worker/evaluator.ts:152–159,205–214` 先同步领任务再 lanes 消费；租约 60 秒（:38），接口允许超时 120 秒（`src/app/api/settings/jev/route.ts:27`）。`src/worker/main.ts:68–75` 每轮采集会回收过期租约。队列中的已领取任务也计时、无续租，完成/失败更新未检查 owner（`src/lib/db/repos/jobs.ts:141–145,175–197`）。这是代码推导风险，未跑故障复现。
- `src/lib/jev/client.ts:104–136` 网络/超时可重试、401/403 auth、5xx/429可重试、非法 JSON/结构不可重试；evaluator 当前只消费 code 不消费 retryable（:190–197）。非法单答案被 parseAnswers 标为 failed、不抛异常，最终 completeJob。

## 密钥与费用

- `src/lib/service/config.ts:37,82–102,243–256` 单 namespace `jev.apiKey`，空值保留、非空替换、显式 clear 清除。运行时只有一个明文 Key；网页读取 configured/masked/unreadable。
- settings 与 secrets 通用仓库可以复用，但现有保存配置和密钥没有共同事务。`src/lib/db/migrations.ts` 目前 V1；新增池/用量需增量迁移，不能修改已应用 V1。
- 三入口：生产 evaluator、`src/lib/service/dry-run.ts`、`src/app/api/settings/jev/test/route.ts`。连接测试内部吞异常（`src/lib/jev/client.ts:151–182`），调度层必须能获取原错误类型。
- `src/lib/jev/types.ts:22–26` usage 为 unknown 可选；未定义顶层字段被 zod 去除。生产/试判/测试均不落请求用量，evaluations 的 upsert 不能还原历史收费。

## 记录页

- 状态 `src/lib/service/bulletins.ts:21,50`：baseline / pending / matched / uncertain / failed / not_matched；优先级 baseline > matched > failed > uncertain > 其他已判断 > pending。失败 job 尚未落 evaluations 时可能显示 pending，本期设计要核验此边界。
- `src/app/api/bulletins/route.ts:9–16` 仅 limit/offset/sourceNs，固定 baseline:false；仓库分页后服务投影，不能在分页后过滤状态。
- `src/app/(admin)/bulletins/page.tsx:23–31` 最近 50 条、无条件 30 秒刷新、手动刷新无在途保护。
- `src/components/use-api.ts:21–48` setInterval，无锁/abort/请求序号；`src/components/api-client.ts:32,71` 不接收 signal，未显式 cache。共享 hook 同时供频道、状态、Jev 等页使用，修改需回归其他页面。
- `src/app/(admin)/jev/page.tsx:16,120,166,174,226` 当前单 Key 表单、连接测试、试判，无费用区。

## 官方证据

- `research/pricing-models.md`：Jev 1.13 输入 $0.042/Mtok、输出免费；64k 全请求 / 32k state+最长问题；动态 TPS/RPS 限额。
- `research/pricing-primitives.md`：同 state 的问题推荐同请求；增加问题仅增加问题 Token。
- `research/pricing-responses-python.md:44–52`：用量项可缺失。`research/pricing-with-response.md`：request ID 来自 x-typesafe-request-id。
- `research/pricing-api.md`、`research/pricing-help-errors.md`：429/529退避，尊重 Retry-After。
- 官方并未核实缓存单独价格、失败请求账单、多 Key 限流共享范围；批处理案例仅作说明，不能保证固定省费比例。
- 复现：`smart-search fetch 'https://docs.typesafe.ai/models.md' --format markdown --output .trellis/tasks/10-14-jev-key-pool-usage-records/research/pricing-models.md`；其他原文以同方式 fetch，来源 URL 保存在各文档及 PRD。

## 后续验证入口

现有 vitest node 环境；无浏览器测试库。重点：`tests/service/config.test.ts`、`tests/worker/evaluator-concurrency.test.ts`、`tests/worker/pipeline.test.ts`、`tests/jev/prompt.test.ts`、`tests/jev/client.test.ts`、`tests/service/dry-run.test.ts`、`tests/service/bulletins.test.ts`、`tests/db/migrate.test.ts`。实施完成后运行 pnpm lint/typecheck/test/build 并实际核验页面筛选/自动刷新。当前仅规划，无需为文档更新运行产品检查。
