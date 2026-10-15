# 规划核验与主代理复核（2026-10-14）

两路 default/fork_turns=none 探子分别核验 Key/并发/迁移与费用/列表/轮询，只读且没有产品实现。所有实质 finding 由主代理沿锚点复核后写入 design.md 与 implement.md。

| 发现 | 点验依据 | 已修订契约 |
| --- | --- | --- |
| web/worker迁移的 applied 在事务外读取，存在并发启动竞态 | `src/lib/db/migrate.ts:21–35` | BEGIN IMMEDIATE内重新读版本；两进程并发启动V2只应用一次 |
| interrupted状态与迟到真实用量的写入条件矛盾 | 原design请求终态/租约定义 | 增加result_recorded_at；interrupted可接收真实结果一次，容量/job owner/真实结果分别判断 |
| 同路径reload跳过会丢保存后的刷新 | `src/components/use-api.ts:30–47`、`src/app/(admin)/channels/page.tsx:142`、`src/app/(admin)/jev/page.tsx:212` | 轮询跳过，显式reload排尾随新请求；保存前旧GET不能替代保存后刷新 |
| 切换筛选失败仍展示旧查询数据 | `src/components/use-api.ts:26–40` | data/error/loading关联path/generation，新查询隐藏旧数据，仅同查询错误保留旧列表 |
| count与items/详情分开读会跨worker写入快照 | `src/lib/db/repos/bulletins.ts:156–165`、`src/lib/service/bulletins.ts:82–85` | 一个同步只读事务读取count、分页与投影 |
| 输出用量缺失不应使仅输入计费变未知 | 官方pricing-models与responses-python | input未知才无法按输入费率计价，output未知仅影响输出用量显示 |

规划核验支持当前费率与金额换算、已有单请求多需求、统计起始边界；修订没有改变用户确认的连续三次失败规则。主代理随后读取收敛PRD/设计/实施文档，运行任务上下文验证并检查差异只涉及本任务文档。产品lint/typecheck/test/build留待实施后运行。

## 方案批准记录（2026-10-14，新会话）

用户在本会话粘贴启动词：「我批准『Jev 多密钥并发、费用统计与线报记录筛选刷新』任务的现有完整方案，请在这个会话开始实施」，
并重申四条关键要求（多 Key 并发 + 连续三次实际失败禁用；同线报需求合并为一次请求；美元费用估算覆盖后台/连接测试/试判/每次重试，
未知用量不得显示为零；记录页状态筛选、分页与默认关闭的五秒自动刷新）。同时特别要求遵守设计中并发迁移、任务租约、
迟到响应记账与保存后刷新的修订。据此 `plan_approved` 置为 true，进入 Phase 2 实施；规划内容与范围不变。

## 批准记录复核（2026-10-14，实施会话）

实施会话再次核对：`task.json.status=in_progress`、`meta.plan_approved=true`、上下文清单 `implement.jsonl`(12)/`check.jsonl`(11) 通过
`task.py validate`，且用户在本会话重申批准并列出四条关键要求。据此批准记录确认有效，无需重建任务或重复规划；
本会话续接前序已落地的「V2 迁移 + Key/账本仓库 + 适配器用量归一化」，按 implement.md 完成统一请求服务、Worker 租约、
页面/API 与筛选刷新，再执行完整质量检查与收尾。
