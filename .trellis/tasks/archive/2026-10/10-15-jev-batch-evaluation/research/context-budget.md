# 32k 约束对批量方案的影响

核验日期：2026-10-15。用户本轮问题：“jev 的上下文只有 32k。容得下吗？”本轮仍为规划，没有选择路线或开始实现。

## 官方证据

经 smart-search CLI 抓取，原文分别保存在 `context-models.md`、`context-primitives.md`、`context-jaggedness.md`。

1. [Models](https://docs.typesafe.ai/models.md)：

   > “64k tokens per request; 32k tokens for state plus the longest question”

   > “Jev ingests the state once and evaluates every question against it in parallel.”

   共有两道输入预算。设共享 state 为 S，各题含 instructions/criteria 的完整问题规模为 Qᵢ，则须满足 `S + max(Qᵢ) ≤ 32k`，以及 `S + ΣQᵢ ≤ 64k`；精确序列化与 token 计算方式仍需官方工具或协议补充核实。

2. [Primitives](https://docs.typesafe.ai/primitives.md)：

   > “Every question in a request sees the same state”

   以字段路径定位线报只改善判断指向，不会把每题上下文变成单条线报。题数没有单独的固定上限，但仍受请求规模约束。

3. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)，页面标注最近审阅于 2026-10-02：

   > “Accuracy falls as the state grows with content unrelated to the decision.”

   对某一线报的问题，其余线报可能成为干扰；能放进上下文不能证明分类可靠。页面建议优先提供决策所需字段、减少无关内容。本任务不能据此擅自删除现有正文或增加关键词硬排除。

## 方案修正

- 不能无条件保证 10 条或一个完整采集批次能容纳。没有真实输入长度分布和可靠 tokenizer，目前不能给出可信的“每批多少条”。
- 举例仅为算术演示，假定已按正确 tokenizer 计数：每条输入 1k、10 条约 10k，仍须加题目与结构开销；每条 8k、5 条的 state 已约 40k，会超过 32k。以上不是当前线报平均长度。
- 用户原提案的整批预筛同样需把整批内容输入 state，也会遇到 32k，不能靠只问一个问题突破 state 限制。
- 批量逐项方案收紧为待验证候选：按输入预算动态组成小批，附独立条数上限，长文单条处理；不以凑满 32k 为目标。具体预算和安全余量未定。
- 单条超限属于已有问题，不能用继续拆批解决；不静默截断、不标未命中。若要摘要、提取相关段落或截断，必须另行明确语义和验收风险。
- 上下文预算需同时控制 state 与全部题目；需求数增多时，即便 state 未满，也可能先遇到 64k 总量限制。
- 输入超限后的拆分恢复只是异常兜底，不能替代发送前预算，也不能忽略额外调用、重试和已发生费用。

## 命令记录

```sh
smart-search fetch 'https://docs.typesafe.ai/models.md' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/context-models.md
smart-search fetch 'https://docs.typesafe.ai/primitives.md' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/context-primitives.md
smart-search fetch 'https://docs.typesafe.ai/model-jaggedness/jev-1.13.md' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/context-jaggedness.md
```

仅使用官方文档读取，没有发出真实 JEV 模型请求或读取真实线报内容。可靠 tokenizer、中文线报长度分布、批量准确率与允许等待时限仍未核实。
