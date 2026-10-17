# 可信度门控与判定追溯：技术设计

状态：待用户最终审阅；仅规划，不授权实施。首期范围为 R1、R2。初始参数及兼容行为以本文件为准，获批后实施。

## 1. 决策边界

数据流：统一请求服务 → 原有 parseAnswers → **共享纯决策函数** → 业务 result＋追溯快照 → evaluations / 试判 DTO → 列表、详情、通知。

- 新模块建议 `src/lib/jev/match-policy.ts`，不读环境变量、数据库或当前时间。自动与试判显式调用同一函数。
- 不改变 parseAnswer、Choice 提示词及 RULE_VERSION。批次预筛、正则过滤、连接测试不应用逐需求确认策略。
- 所有进入逐条判断的 individual / batch_gate / regex_gate 路径应用相同策略。不增加 Jev 请求、自动复判或人工确认工作流。
- 业务 result 沿用 matched / not_matched / uncertain / failed；“待确认”包含模型不确定和程序降级两种来源。

## 2. 初始策略 `match-confirmation-v1`

建议固定版本化参数：`minMatchedProbability=0.80`，`probabilitySumTolerance=0.01`。首期没有设置页开关，不新增全局配置/run 快照；策略在逐条请求开始前捕获一次，响应后使用同一快照。改变算法或参数必须提升策略版本并记录新快照，不能修改旧记录解释。

confidence 保留和展示，但不参与匹配门槛：已有文档仅说明它来自分布集中程度，无法据此把 0.28 解读为 28% 正确率。新增门控以完整概率分布为依据，不宣称已经校准准确率。0.80 是初始业务取舍，最终审阅即明确批准此参数；没有真实业务总体校准结果。

### 2.1 处理顺序及确定性原因码

| 顺序 | 输入情况 | 最终 result | reason |
| --- | --- | --- | --- |
| 1 | 原解析结果 failed（缺题、非法 choice、类型错误等） | failed | `parse_failed` |
| 2 | 原结果 not_matched | not_matched | `model_not_matched` |
| 3 | 原结果 uncertain | uncertain | `model_uncertain` |
| 4 | matched，probabilities 缺失 | uncertain | `probabilities_missing` |
| 5 | matched，概率结构在下述业务校验不合法 | uncertain | `probabilities_invalid` |
| 6 | matched，但 matched 概率严格小于其他任一选项 | uncertain | `choice_probability_conflict` |
| 7 | matched，p_matched < 0.80 | uncertain | `matched_probability_below_threshold` |
| 8 | matched，通过上述检查 | matched | `matched_confirmed` |

分布业务校验：键**恰好**为 matched / not_matched / uncertain，每值有限且处于 [0,1]，`abs(sum−1) ≤ 0.01 + 1e-12`。不补缺项、不截断、不自动归一化。阈值比较使用原始值 `>=0.80`，不按显示小数四舍五入；0.7999 不通过，0.80 通过。选项一致性判断直接使用原始值；并列最高本身不构成冲突，低于阈值仍降级。

基础解析仍保持原有失败语义，例如 probabilities 非数值或显式 null、confidence 类型错误导致 parse_failed，不为了降级而放宽协议。有限但不合法的分布会在业务层降级。not_matched / uncertain 不因分数差而被升级或重新分类；其分数仅作原始数据。

缺 confidence 不阻止合法概率分布的匹配；若 confidence 有限但越界，展示“上游置信度异常（原值 …）”，不称其为有效置信度；它不改变概率门控结果。非有限/非数值的失败行为仍归原解析器。

程序降级 `error=null`，不重试、不增加 Key 失败计数。HTTP 成功的调用账本仍为成功；上游请求失败与解析失败保留原有失败路径。策略不是“原文证明”，不保证拦住高概率的品牌误判。

### 2.2 样例

- 本案 matched / p=(.52,.15,.33) / c=.28 → uncertain，原因“匹配概率 0.52 低于自动确认门槛 0.80”。
- matched / p=(.80,.10,.10) → matched；(.7999,.10,.1001) → uncertain。
- matched / p=(1,0,0) → matched，保留归档抽纸正例的业务行为。
- matched / 无概率 → uncertain；缺 confidence 但 p=(.9,.05,.05) → matched。

## 3. 持久化及 DTO 契约

V4 追加 evaluations 列；不修改 V1—V3，不回填旧行、不改变唯一键：

| 列 | SQLite 类型 | 新记录语义 |
| --- | --- | --- |
| `model_result` | TEXT NULL | 原解析三态；parse_failed 时 NULL，不伪称 failed 为模型选择 |
| `decision_reason` | TEXT NULL | 上表原因码；新失败记录也含 parse_failed |
| `decision_policy_version` | TEXT NULL | `match-confirmation-v1` |
| `decision_policy_json` | TEXT NULL | `{minMatchedProbability:0.8,probabilitySumTolerance:0.01}` |
| `jev_request_id` | TEXT NULL | 成功响应所对应的实际调用账本 ID，无级联删除 |

现有 `result` 保存最终业务结果；probabilities/confidence/raw_answer 不改写；error 只存真实失败。所有字段在 upsert 冲突更新时一起替换，沿用 attempts 累加及原 created_at，不承诺逐次尝试审计。

领域类型/DTO 增加：`modelResult: ChoiceOutcome|null`、`decisionReason: DecisionReason|null`、`decisionPolicyVersion: string|null`、`decisionPolicy: {minMatchedProbability:number;probabilitySumTolerance:number}|null`、`jevRequestId: string|null`。repo 唯一负责 policy JSON 解码和基础结构校验；旧行或异常快照返回 null，不能默认为当前策略或让整个详情崩溃。

自动调用落库 configVersion 使用 `outcome.semanticConfig.configVersion`（正常有值；缺失时明确使用现有必填字段允许的回退并测试，不伪称为精确快照）。建议以调用前捕获值兜底，追溯以 requestId 关联账本为准。试判成功响应顶层也使用实际预约配置版本，响应 model 仍取真实响应。

试判逐需求返回同样追溯字段，继续返回对象概率；持久化 DTO 保留原概率字符串。规则版本和配置版本在详情同步镜像为 DTO 字段，供追溯展示。不把完整 raw_answer 新增为 UI 大块输出，不展示密钥/请求头。

## 4. Worker、通知和状态

- 请求开始前捕获不可变策略；响应后各题生成 decision。使用最终 result 计数、更新 processing、决定通知，保持 evaluated 阶段可包含 uncertain。
- 落库与通知仍在原 `persist.immediate()` 中，先核验 owner，租约失效不写业务记录。
- 收集**本次成功 upsert 的匹配项**，禁止重新扫描全部历史 matched 组成新通知。可在同一事务内按本次 needId＋RULE_VERSION 精确读取/返回 upsert 后记录，数组只包含最终 matched，非空才创建通知。
- 保留 `notifications.bulletin_id UNIQUE` 和现有投递幂等；已存在通知不改 payload，不重复投递。发送端不重新跑模型或门控。
- 列表、详情、筛选和计数仍使用唯一的 BULLETIN_DISPLAY_STATUS_SQL；新写入的 result 已为业务结论，不在 UI 另算门槛。
- 保留混合状态优先级 `baseline > matched > failed > uncertain > not_matched > pending`，本地过滤分支按现有表达式。另一需求已通过匹配时整条仍匹配，但通知不包含被降级需求；同条含 failed 和 uncertain 时总体按现有 SQL 显示 failed，逐需求仍如实呈现。

## 5. 历史兼容与生效范围

- 策略只作用于升级后实际执行的逐条判断和试判，包括升级前已入队但尚未执行的任务；不以采集时间决定策略。
- 旧 evaluations 新追溯字段均为 NULL，显示“历史记录：未记录匹配确认策略”，保留原 result，不推断原模型选择，不默认“已通过”。
- 同 RULE_VERSION 下自然重试仍覆盖该需求旧行，现有行为不变；不自动入队重算旧公告。
- 不提升问题模板版本，避免本次新增重复历史行。若数据库已含别的 rule_version 的 matched，现有跨版本聚合仍保留，详情提示“含历史判定，未按本策略重算”；首期不解决独立的跨版本有效记录选择。
- 旧 pending/failed/sending 通知继续使用原 payload，升级不会撤销或阻断它们。详情有旧通知时不能因当前 uncertain 而写“从未发送通知”，改成“本次待确认不产生新通知；已有通知及投递见下方”。
- 新策略只承诺新业务判断的确认门槛，不把旧记录展示成已应用新策略。历史重算、撤回通知和整库治理后续单独规划。

## 6. 页面与文案

- `EvaluationDto` 与 `DryRunNeedResultDto` 镜像同一追溯字段；后端不可直接被客户端导入。
- 详情/试判使用相同展示组件或共享格式化映射：最终结果 badge、模型原始选择、概率、原始 confidence、程序判定原因、实际门槛/策略版本。正常降级用 notice/warning 或普通说明，不使用 error 红色；失败仍显示真实 error。
- 共享 uncertain 标签改为“待确认”；列表/状态页引导注明“信息不足或未通过匹配确认”。模型 uncertain 单独显示“模型信息不足”，被降级显示“模型匹配 → 业务待确认”。
- 置信度附近说明“上游分布集中程度，不代表业务正确率”；概率显示保留现有数字格式，但原因中用保存的实际分数和门槛，不能以显示舍入值重新决策。
- 历史项原始选择/策略显示“未记录”，不隐藏其原有结果；程序分类说明维持明确来源标注。共享 `buildClassificationExplanation(needNames)` 继续使用现有“被 Jev 判为符合需求”模板，不改成“经匹配确认”，因为它同时服务历史/混合公告详情、新通知和连接测试。是否经过新策略只由逐需求追溯字段说明，不能仅凭当前 matched 状态推断。旧通知快照不重写，连接测试不宣称通过业务匹配确认。
- 保留真 table＋TableScroll、Mantine 控件和既有主题令牌；逐需求表延续现有完整详情呈现，本期不额外改造分页。新增字段可用同单元格副文本，避免无上限扩张列宽。浅/深主题均检查。

## 7. 风险、验证和发布

- 无充足真实标注样本，不能证明 0.80 最优；它会增加待确认并可能减少有效通知。后续基于人工标注样本调整时升策略版本。
- 高概率错误仍可能通过，尤其品牌混淆；明确列为后续 R3 能力，不假装此策略完成语义证据核验。
- 测试须覆盖边界/异常/实际副作用和旧库兼容，见 implement.md。真实付费调用、线上重算和生产部署均不是规划验收的前提，本轮未执行。
- 发布时停止 web/worker 旧实例、备份 SQLite、运行增量迁移、统一版本启动，避免旧 worker 写入无追溯判断。是否部署由用户后续授权。
- 回滚停止所有新实例，按项目规范恢复同版本数据库备份和匹配镜像；不能只回退镜像并宣称新策略仍有效。已发通知无法由回滚撤回。
