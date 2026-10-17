# 执行计划（待最终审阅）

仅规划；不得因本文件存在直接 start。用户明确批准最新规划后，才使用 task.py start 进入实施。

## 1. 实施前核对

- [ ] 核对 prd.md、design.md 与用户最新批准内容，尤其初始 p_matched≥0.80、缺概率转待确认、旧通知不撤销。
- [ ] 确认工作树和迁移最新版本，当前是 V3；若有并行任务，追加最新迁移号，不能覆盖他人改动。
- [ ] 读取 implement.jsonl 中规范，及 `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` 等本次修改相关本地 Next.js 指南。先读即将修改的确切代码。
- [ ] 基线验证；本次规划不执行模型请求、线上写入或代码测试，不把规划校验称为产品测试。

## 2. 纯决策契约（R1 / AC1—AC3）

- [ ] 新增 `src/lib/jev/match-policy.ts`：版本化不可变默认策略、决策返回类型、原因枚举、完整分布校验和确认函数；confidence 不作正确率阈值。
- [ ] 保持 `src/lib/jev/prompt.ts` / `types.ts` 的现有基础解析兼容语义，批次解析不调用新门控。
- [ ] `tests/jev/match-policy.test.ts` 覆盖下表中算法边界，明确算法样本不是业务效果校准。

## 3. 增量迁移和仓库（R2 / AC4、AC5）

- [ ] `src/lib/db/migrations.ts` 追加 nullable 追溯字段；不回填旧记录、不修改唯一键。
- [ ] `src/lib/domain/types.ts`、`src/lib/db/repos/evaluations.ts` 同步字段，repo 解码策略 JSON；upsert 同步替换追溯信息、保留原值及 attempts 语义。
- [ ] 原始概率/置信度/raw_answer 与最终 result 可往返；旧行 NULL、异常 JSON、重复迁移、同键重试覆盖都测试。

## 4. 自动判断、试判与通知（R1、R2 / AC1、AC2、AC4、AC6）

- [ ] `src/lib/worker/evaluator.ts` 请求前捕获策略；解析后共享决策；owner 事务内保存最终结论及 requestId、实际 configVersion、策略快照。
- [ ] 计数/processing/通知均依据最终 result，程序降级 error=null，不发匹配通知、不增加模型调用次数、不触发重试。
- [ ] 通知只从本次成功写入的匹配项构造，避免历史 matched 混入；保持已存在通知/投递幂等。
- [ ] `src/lib/service/dry-run.ts` 调同一函数，逐需求返回追溯字段；仍只允许调用账本副作用，无业务表写入。
- [ ] `src/lib/notify/dispatch.ts` 的共享分类模板保持原文，不将其统一改成“经匹配确认”；连接测试和历史详情均不能暗示应用了新策略。`src/lib/service/bulletins.ts` 保持程序说明与追溯字段分工，补历史/混合记录回归；不改旧 payload。
- [ ] 回归三模式和 owner 丢失测试；配置在调用时变化后追溯仍指向实际请求版本。

## 5. DTO 与页面（R2 / AC4、AC5）

- [ ] `src/components/api-types.ts` 镜像领域/试判新增字段和原因枚举；共享原因文案/格式化放到客户端公共组件，不能导入服务端代码。
- [ ] 公告详情和 `DryRunPanel.tsx` 显示原始选择→业务结果、原因、分数、策略快照，旧记录清晰标为未记录策略。
- [ ] 同步 `bulletins/page.tsx`、`status/page.tsx`、详情 uncertain 文案；error 样式只用于实际失败，已有通知时不写“未发送过”。
- [ ] 新结果在列表、详情、筛选、计数与通知成员中一致；保留原 SQL 状态 owner，不在前端计算门槛。
- [ ] 每个改动页面浅/深主题、横向表格滚动、窄屏及空状态检查。没有新主题系统或页面结构改造。

## 6. 验证矩阵

| 场景 | 可观察断言 | 主要测试位置 |
| --- | --- | --- |
| 安乃安用户案例回放 | 原 matched 保存，业务 uncertain，明确原因，无 notification/delivery | match-policy、pipeline、dry-run |
| p=.80 与 .7999 | 前者匹配、后者待确认；显示舍入不改结果 | match-policy |
| 缺概率/空分布/缺键/多键 | matched 降级；不生成伪造概率 | match-policy、pipeline |
| 负数/>1/总和误差边界 | invalid reason；总和容差含浮点误差；不归一化 | match-policy |
| choice 与最大概率冲突/并列 | 冲突降级；并列仍过阈值检查 | match-policy |
| confidence 缺失或有限越界 | 不冒充 0；概率合法时按概率决策，越界展示异常 | match-policy、DTO |
| 非法选择/分数字段类型错误 | 保持 failed，error 非空，不能渲染成待确认 | prompt、pipeline |
| not_matched / uncertain | 不升级；不产生匹配通知 | match-policy、dry-run |
| .9 正例/归档 p=1 正例 | 确认匹配，通知只含已确认项 | pipeline |
| 混合通过/降级/failed | SQL 优先级不变，通知排除降级和失败项 | bulletins、pipeline |
| 当前确认项＋额外历史 matched | 新 payload 仅含本次有效确认项；旧聚合行为按兼容设计保留 | pipeline |
| 三模式精判 | 同策略、同调用次数；批次排除/正则过滤仍无伪 evaluation | three-modes、batch-gate |
| 旧库/重复迁移/同键重试 | nullable 兼容，旧结果不变，快照同步覆盖，attempts 正确 | migrate、repos |
| owner 丢失 | 无业务判断/通知写入，实际调用账本保持原语义 | evaluator-lease |
| 试判/自动一致 | 同结果和追溯快照；试判不改 evaluations/notifications/deliveries/jobs | dry-run、pipeline |
| 旧通知已排队/已发送 | 无撤回、无改写、无新增重复投递；详情文案准确 | pipeline、bulletins |
| 纯历史/混合历史详情、连接测试 | 共享说明不宣称经过新策略确认；策略应用情况只由真实追溯字段显示 | bulletins、通知构造/连接测试既有测试 |
| DTO/历史/null 展示 | 不伪造模型结果/策略；正常降级非红色错误 | service、浏览器人工检查 |

优先扩展现有测试：`tests/db/migrate.test.ts`、`tests/db/repos.test.ts`、`tests/service/dry-run.test.ts`、`tests/service/bulletins.test.ts`、`tests/worker/pipeline.test.ts`、`tests/worker/three-modes.test.ts`、`tests/worker/evaluator-lease.test.ts`，新增决策纯函数测试。针对新缺口建测试，不为每个文案写实现镜像测试。

实施阶段验证命令：

```sh
pnpm test -- tests/jev/match-policy.test.ts tests/jev/prompt.test.ts tests/jev/batch-gate.test.ts tests/db/migrate.test.ts tests/db/repos.test.ts tests/service/dry-run.test.ts tests/service/bulletins.test.ts tests/worker/pipeline.test.ts tests/worker/three-modes.test.ts tests/worker/evaluator-lease.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

完成后使用 trellis-check 检查跨层契约及测试结果；按 trellis-update-spec 同步数据库字段、业务策略与 uncertain 文案规范，必要时同步数据库规范要求的设计索引。提交和 finish-work 遵守当时用户授权与工作树范围，不纳入无关变更。

## 7. 发布边界与回滚点

- 本任务实现验收不自动部署、不真实试判、不重算生产旧数据；需要时后续单独安排。
- 部署前备份库、停止混合版本 worker，统一迁移后启动；确认升级后新判断带策略版本。
- 回滚按 design.md 恢复同版本镜像及数据库备份；已发通知无法撤回。仅更改门槛也须提升策略版本，禁止改写旧快照。
