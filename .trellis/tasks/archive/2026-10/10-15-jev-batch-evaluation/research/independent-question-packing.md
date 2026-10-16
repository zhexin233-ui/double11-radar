# 全量判断、合并请求：每题携带专有线报

日期：2026-10-15。用户已否定正则未命中就跳过的方案。以下是保持语义判断覆盖、减少实际请求的候选，不是已批准设计。

## 目标

保持每条非基线新增线报对全部启用需求的独立判断，把多个判断打包到一次 HTTP 请求，避免通过人工词表省略语义判断。每条都参与并不代表模型绝对零误判，仍需真实样例验证。

## 官方证据

通过 smart-search CLI 抓取 [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)，原文保存于 `question-packing-official.md`：

> “They can also be objects or arrays. Put the question in one field and the data that guides the question in the others.”

> “Several questions have similar instructions. A request takes one state and can include multiple questions. Adding supplementary data can help make questions distinct.”

文档示例说明来自数据库的候选记录可作为各题专有的 `potential_duplicate` 数据，并从该题 instructions 中引用；问题独立评估。结合 `context-primitives.md` 和 `context-models.md` 可研究以下布局。

## 候选布局

- state：公共匹配规则等确需共享的短上下文。
- 每个 question：一个线报×一个需求。携带这一条线报的标题、完整现有正文、商品字段及目标需求，保留现有 Choice 三态 criteria。
- 稳定 question ID 仅供程序映射；所需语义、专有字段引用必须写在题内，不能依靠 ID 向模型传递含义。
- 同一次请求携带多个这样的独立 question，每个都应有独立答案；合法结果按对应线报和需求落库，缺题或错误项可恢复，不默认为未命中。
- 该方式与早期方案的区别是无需把所有线报放入共享 state；各题无需被提供其他线报内容作为共享背景。

当前 `JevQuestion.instructions` 是 string（`src/lib/jev/prompt.ts:16`），可以先研究在 string 中明示并编码该题专有数据，或在核验完整协议后扩展为结构化 instructions；不能把支持结构化的官方说明当作本地类型已经支持。无论采用哪种表示，都是待实测的新输入布局，不能宣称准确率已与旧方式相同。

## 容量与取舍

令公共 state 的 Token 为 S，各题完整题目为 Qᵢ，仍需 `S + max(Qᵢ) ≤ 32k`、`S + ΣQᵢ ≤ 64k`。原来共享 state 的全部线报正文在这里移入各题，不再共同占用每题的 32k，但会消耗整请求预算。

一条线报若对应 M 个需求，正文可能重复进入 M 个题目，增加 Token。该取舍符合用户首要目标为减少请求，但仍需记录额外输入费用；不能认为该布局总是优于共享 state。短文多需求、长文少需求应分别比较两种布局。

容量不足就拆为多个请求；单题仍超限须明确异常，不能静默截断或跳过。可靠 tokenizer 与实际输入计数仍未核实，暂不承诺批次规模。若全部有效题目一组能容纳，命中与否不改变正常请求数，不再整批重判。

## 尚待确认或验证

1. 用户是否接受有上限的凑批等待；建议最多 5 秒，尚未批准。无额外等待只能合并已排队题目，输入稀疏时无法保证省调用。
2. 批量合法结果是否直接使用，异常项如何补齐及重试。
3. 价格目标、单位和缺价处理仍未决，不在本轮默认新增历史低价。
4. 真正的 Token 预算、独立题内数据的中文语义准确率、部分缺题率、端到端延迟、实际总调用数需对照验证。

## 命令记录

```sh
smart-search fetch 'https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/question-packing-official.md
```

本轮只读官方文档并更新规划文件，没有发出真实 JEV 模型调用或修改产品代码。
