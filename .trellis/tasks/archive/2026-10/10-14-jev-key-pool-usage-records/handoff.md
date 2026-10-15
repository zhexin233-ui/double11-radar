# 转到新会话实施交接

## 状态与启动条件

用户最新指令：「我要在别的会话执行，给我一份开头词」。本会话只保存规划和交接，不启动实施。

- 完整方案已呈现，PRD/design/implement齐备，implement.jsonl 12项、check.jsonl 11项通过 task.py validate。
- 用户已明确选择失败方案1：连续三次实际请求失败禁用，成功清零；超时、429、5xx均计入。
- 当前 status=planning；plan_approved=false 表示还未收到明确批准完整方案的启动消息，不表示文档未就绪。
- 给用户的启动词明确写有「我批准现有完整方案，请在这个会话开始实施」。新会话收到用户亲自粘贴的启动词后，即取得最新方案批准，可更新批准记录并运行 task.py start，不再询问同一批准或重建任务。

## 定位与必读材料

仓库：`/Users/zhexin/github/11jev`。

任务：`/Users/zhexin/github/11jev/.trellis/tasks/10-14-jev-key-pool-usage-records`。

先读仓库 AGENTS.md，按 Trellis start/continue 获取新会话上下文；主代理亲自完整阅读本任务 prd.md、design.md、implement.md 与本交接。随后按清单加载真实 spec/research 与对应阶段详情。开发前重新确认现有源码、git status与数据库迁移版本，保护其他会话变更。

## 收敛范围

1. Key池与全局并发：保留单Key并发能力，多Key优先均匀分配；默认并发1、范围1—8。连续三次所有实际请求失败禁用，成功清零，禁用状态持久化；手动恢复/替换清零，旧generation迟到响应不改新Key状态，迟到成功不自动启用。
2. 每条线报已是全部启用需求一次请求，保留稳定question ID独立结果，不改成互斥问题、不关键词预筛。同状态合并请求避免重复输入，官方按输入Token收费。上游上下文超限明确失败，不静默丢需求或猜Token裁剪。
3. 请求账本涵盖后台/测试/试判及每次实际重试；当前官方Jev1.13输入$0.042/Mtok、输出免费。按响应用量与模型/费率快照估算美元，未知输入/价格标未知；仅output缺失不影响输入费用。统计从功能启用后开始，不倒推历史账单。
4. 记录状态筛选在SQL分页前执行，count/items/投影保持同一快照；增加分页与默认关闭的五秒自动刷新、手动刷新，保留筛选/页码并避免重叠和旧数据串查询。

## 必须保留的核验修订

- 增量迁移与旧密文迁移；migration runner在BEGIN IMMEDIATE内读已应用版本，两个进程同时启动均成功。
- 不提前领满等待队列消耗租约；timeout+收尾余量与claim owner保护避免旧任务覆盖新判断/通知。
- request容量租约、job owner、真实结果完成分开；interrupted允许真实迟到结果幂等更新一次，用量不因失去job owner而丢弃。
- 定时tick可跳过；保存后reload必须保证写入后启动的新请求，不能合并到旧GET；新查询不展示旧查询数据。
- 全池不可用保持队列可恢复；429/529遵守Retry-After，同时按用户规则计失败。平台故障可能全池禁用，多Key是否共享账号限额未核实。

完整理由、代码锚点和测试矩阵见 design.md、implement.md、research/current-behavior.md、research/planning-review.md。官方原文均由smart-search抓取并已保存，不需重新进行相同调研；如有新的网络信息需求仍只用smart-search CLI。

## 本次已做与未做

只修改本任务规划、研究、清单、元数据与交接文档，未改产品代码、未运行task.py start、未发真实Jev/通知请求。未运行产品lint/typecheck/test/build；这些必须在实施后按执行计划完成。所有规划文件保留在共享工作目录，部分仍未跟踪/未提交，不得清理丢弃。

所有回复、代码注释、提交说明使用简体中文，包管理器pnpm。子代理及实施路由按新会话适用AGENTS/技能/开发者指令执行；主代理仍负责方案取舍、承重原文阅读、最终核验和收尾。
