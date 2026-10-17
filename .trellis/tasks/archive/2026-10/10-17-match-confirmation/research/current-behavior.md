# 现状与证据（2026-10-17）

本次仅本地只读研究；未访问线上数据库、未读取凭据、未调用模型。行号对应研究时工作树，实施前按符号复核。

## 分数契约与证据强度

- 已有官方文档归档：`.trellis/tasks/archive/2026-10/10-14-jev-key-pool-usage-records/research/pricing-api.md:1`。Choice 的 choice 是最高概率选项；probabilities 是全部选项组成且总和为 1 的分布；confidence 为 0—1、从概率分布推导。
- `pricing-primitives.md:7` 说明 confidence 概括分布集中程度。未找到精确公式或它等于业务正确率的依据。上述为仓库归档，未重新联网验证上游当前契约。
- 同目录 `pricing-models.md:1` 提醒别名会漂移，响应 model 可追溯实际版本；已校准阈值适合固定模型版本。本期不擅自改变用户模型配置。
- 真实模型的有限样本在 `.trellis/tasks/archive/2026-10/10-13-xianbao-needs-matching/research/real-acceptance-2026-10-14.md:22`：两个抽纸正例 p_matched=1；其他输入是不匹配或不确定。它们是人工构造输入的真实调用，不是业务总体分布，不能给出准确率、召回率保证。
- 用户案例 p=(0.52,0.15,0.33)、confidence=0.28，为用户提供详情，尚未直接查库核实。测试中的 0.9 等分数属于 mock，只能验证算法分支。
- 因此初始 p_matched 门槛 0.80 是待用户审阅的保守业务参数，不是经业务样本校准得到的参数；不额外叠加没有明确语义依据的 confidence 门槛。概率阈值不等于正确率承诺。

## 解析与调用入口

- `src/lib/jev/types.ts:16`：分数可选，概率接受任意字符串键；`src/lib/jev/prompt.ts:150` 的 parseAnswer 校验三态选择与基础类型，未校验三态概率的范围/完整性/总和/选择一致性。
- `src/lib/jev/prompt.ts:39` 已要求明确符合需求才选择 matched，不因关联品牌匹配。
- `src/lib/jev/batch-prompt.ts` 的 parseBatchGateResponse 复用 parseAnswer。故新的逐需求确认必须位于解析之后，不能改写共享解析语义而影响批次排除。
- 自动：`src/lib/worker/evaluator.ts:322`，parseAnswers → upsertEvaluation → 计数与通知。试判：`src/lib/service/dry-run.ts:102`，同解析后返回 DTO，无业务表写入。
- `src/lib/service/jev-requests.ts` 的 JevCallSucceeded 有 requestId、semanticConfig.configVersion、response.model，可避免使用请求前读取的过期配置版本。

## 持久化、历史与通知

- `src/lib/db/repos/evaluations.ts:82`：唯一键 `(bulletin_id,need_id,rule_version)`；重试覆盖旧判断，attempts 累加，不是逐次审计日志。
- `src/lib/domain/constants.ts:7` 当前 RULE_VERSION=`systemone-choice-v1`。本期不改问题模板、不提升该版本；业务确认另用独立策略版本，避免制造两套同需求行并被旧 matched 抢占状态。
- `src/lib/db/repos/bulletins.ts:178` 是唯一公告状态表达式，任一历史 matched 都参与；`src/lib/service/bulletins.ts:69` 的 matchedNeeds 同样看全部行。本期不重算旧数据，不做跨规则历史治理。
- `src/lib/worker/evaluator.ts:330` 的业务持久化有 owner 守卫；`:357` 通知目前重新收集公告全部历史 matched。本期仅将这一步收敛为本次成功落库的业务 matched，避免新通知混入历史项。
- `src/lib/notify/dispatch.ts:77` 已有通知幂等不更新；`src/lib/worker/deliverer.ts:56` 发送已保存 payload，重试不重判。因此新策略不会撤销已排队的旧通知，也不会改变已发送记录。
- `src/lib/db/migrations.ts` 当前迁移到 V3。新增字段应追加 V4，旧行 NULL，不回填成“已通过新策略”。

## 客户端与验证

- `src/components/api-types.ts:215,295` 分别镜像持久化判断与试判；目前分数字段前者为 JSON 字符串、后者为对象，不在本期顺手改此格式。
- 详情逐需求表 `src/app/(admin)/bulletins/[id]/page.tsx:211`，试判表 `src/components/DryRunPanel.tsx:170`；说明仅有 error，不能把正常降级原因放入 error。
- 共享 uncertain 文案、列表引导、详情无通知文案和状态说明需扩大为“待确认（信息不足或可信度不足）”。保留状态枚举与黄色语义样式。
- 测试入口：`tests/jev/prompt.test.ts`、`tests/service/dry-run.test.ts`、`tests/worker/pipeline.test.ts`、`tests/worker/three-modes.test.ts`、`tests/service/bulletins.test.ts`、`tests/db/migrate.test.ts`、`tests/worker/evaluator-lease.test.ts`。现无页面渲染自动测试，主题验证需要人工/浏览器检查。

## 技术结论与限制

首期可用纯决策模块统一自动/试判，复用 uncertain 保存业务待确认，新增可空追溯字段；无需新队列、新状态或额外模型请求。门槛效果仍待真实标注样本观察，高概率误判仍可能通过。完整尝试审计、品牌证据、历史通知撤回不在本期。
