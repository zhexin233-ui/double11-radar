# 类似 Jev 的本地决策模型

核验日期：2026-10-15。用户明确关注可本地直接判断需求的 Jev 类模型，随后要求继续。本轮仅调研，不代表已批准替换 TypeSafe Jev、部署服务或修改产品代码。

## 结论与优先级

1. **专用决策模型候选：TokenRhythm/NeoHorse-Jev-4B。** 它直接预测 Choice/Noul/Score 及概率，不做自回归文本生成，提供 `/v1/systemone` 风格接口，是本轮发现的较小专用候选；官方部署记录面向 Linux/CUDA BF16 GPU，不能套用普通 4B 聊天模型的 GGUF/CPU 假设。
2. **同类较大候选：autotrust/JEV-9B、autotrust/JEV-27B。** 独立开放权重学生模型，非 TypeSafe 官方权重。9B 比 27B 更轻，二者都需要匹配的适配器、决策头和运行时。
3. **无独显的通用候选：Qwen3.5-2B/4B。** 本地 CPU 可作为试跑路线，要求输出三态 JSON 并校验；这是通用生成模型实现分类，不等于 Jev 原生决策或同等概率校准。实际吞吐、延迟和功耗未知。
4. **更轻的纯分类候选：mDeBERTa NLI。** 约 0.28B，直接输出支持/中立/矛盾的分类分数，支持中文和 CPU，但输入文本对总长 512 tokens，复杂条件与价格不能视为已验证能力。

TypeSafe 官方公开资料目前只找到托管 API，没有找到可下载权重或公开自托管指南；企业私有部署是否可谈须向服务方核实，不能断言所有形式都不可能。

## NeoHorse-Jev-4B：已见事实

来源：[模型卡](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B)、[部署指南](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B/blob/main/DEPLOYMENT.md)，完整抓取保存于本目录 `local-neohorse-4b-source.md`、`local-neohorse-4b-deployment.md`。

- 原文：“a **4B structured decision model**”；“**prefill-only inference** … **Choice**, **Noul**, and **Score** … without autoregressive text generation”。
- Apache-2.0，来自 NeoHorse-1-4B，上游基座为 Qwen3.5-4B；没有证据表明它是 TypeSafe 官方版本。
- 官方已测试环境：Linux、Python 3.12、PyTorch 2.8.0、Transformers 5.17.0、Triton 3.7.1、flash-linear-attention 0.5.2，支持 BF16 的 CUDA GPU；另有 vLLM/SGLang 适配。
- 完整骨干约 9.08GB，另有约 5.25MB 决策头。需完整 bundle 与匹配运行时，不能只下载基础 Qwen、丢弃决策头后声称得到相同模型。
- 原生接口与 `/v1/systemone` 风格接口可用，但不代表本项目适配器无需验证即可切换。
- 默认保护限制：text state 2048 tokens，每题分支 8192，单请求最多 16 问，分支展开总量 32768；不是当前 TypeSafe 32k/64k 的同一契约。可调整保护限额前须验证效果和 GPU 内存。超限明确拒绝、不静默截断。
- 没有查到可泛化的官方最低显存、普通 NAS CPU 运行或量化版部署保证；权重 9GB 不等于运行显存 9GB，不能按“4B×4bit”假定官方决策运行时支持量化。
- 中文商品、优惠、备注排除条件和价格判断尚未做本项目验证，不能把发布者通用成绩转写为线报准确率。

## AutoTrust JEV-9B / 27B：已见事实

来源：[JEV-9B](https://huggingface.co/autotrust/JEV-9B)、[JEV-27B](https://huggingface.co/autotrust/JEV-27B)。9B 完整抓取在 `local-jev-9b-source.md`，27B 关键原文和证据位于 `/tmp/11jev-local-jev-autotrust.md`。

- 模型卡明确 “not affiliated with, endorsed by, or a product of TypeSafe AI, and shares no weights or code with it”。权重 Apache-2.0。
- 9B 基于 Qwen3.5-9B，27B 基于更大骨干；名义参数量不等于 LoRA 训练参数量，不能把约 40M/109M 的适配参数当模型总大小。
- 提供本地 `/v1/decide`，kind 为 noul/choice/score；聊天接口 `/v1/chat/completions` 是独立的生成路径，不是原生决策接口的同义词。
- 9B 下载骨干与适配器约 18GB，27B 约 54GB。官方性能主要在 B200 上报告，不能外推低功耗 NAS、Mac 或消费卡。
- 27B 卡报告约 52GB 权重，256k KV 约 17GB，测试于 183GB B200，并对 80GB GPU 给出较短上下文建议；不是所有任务硬性需要 B200，也不是普通 NAS 可直接承受的体量。
- 本轮未找到官方量化或 Mac/CPU 决策部署说明。仅按纯 4bit 理论算出的约 4.5GB/13.5GB 不构成“可在该显存运行”的证据。

## 通用小模型：已见事实与试跑估算

来源：[Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B)、[Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)、[Ollama 模型入口](https://ollama.com/library/qwen3.5)、[结构化输出](https://docs.ollama.com/capabilities/structured-outputs)。

- 两款 Apache-2.0，2B 默认非思考；4B 默认思考，可通过 `chat_template_kwargs.enable_thinking=false` 关闭。不要混用旧型号的 `/nothink` 软开关。
- 官方存在 Ollama 2b/4b 标签、vLLM 部署说明及 llama.cpp 模型实现。Qwen 官方 GGUF 仓库本轮未核实，不引用猜测链接。
- JSON Schema 能约束格式，不能保证 matched/not_matched/uncertain 的判断正确；生成的 confidence 也不是 Jev 同等校准概率。
- 可用 2B/4B 配合量化、短上下文、单并发在 CPU 上试跑；分别预留约 8GB/16GB 整机 RAM 属于保守试运行建议，不是官方最低值或实测。本机 CPU/RAM 和运行延迟仍未知。
- 这些是已核实的候选，不声称 Qwen3.5 为当前最新系列或穷尽所有更新的小模型。

## NLI 直接分类：已见事实

来源：[mDeBERTa-v3-base-mnli-xnli](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli)、[微软底座](https://huggingface.co/microsoft/mdeberta-v3-base)。

- 分类架构 `DebertaV2ForSequenceClassification`，输出 entailment/neutral/contradiction，不是 embedding；可将线报作为 premise、需求陈述作为 hypothesis。
- 作者卡支持 100 种语言、中文，MIT 许可。微软底座 86M 主干＋190M embedding，约 276M（0.276B）；微调 checkpoint 精确总参数量本轮未逐张量核算。
- 文本对总长度 512 tokens；不能理解成 512 中文字，更不能照抄示例中的 truncation=True 丢弃正文后半。
- CPU 示例已确认；FP32 纯参数约 1.1GB，实际进程另有开销。没有 NAS 吞吐或功耗实测，也没有复杂金额、单位、优惠计算的专项依据。
- 可补充更轻的 multilingual-MiniLMv2-L6-mnli-xnli，底座约 107M，作者报告速度/质量取舍；暂不将其作为复杂需求首选。

## 本项目的推荐取舍

- 若有支持 BF16 的 NVIDIA GPU，可将 NeoHorse-Jev-4B 作为首个专用决策试验，先核实驱动、完整运行时、实际显存、默认输入限制和中文线报表现。
- 若是无独显普通 NAS，先考察 Qwen3.5-2B（资源较充足再对照 4B）或轻型 NLI，不直接建议部署 9B/27B 专用版本。
- 不为“减少云请求”预设自建一定省电或更省钱。已有 CPU 试跑是依据，购买 GPU 的收益需要真实账单和负载比较。
- 仍需用户提供 NAS CPU、内存及独显/显存；所有候选只是在扩大规划比较范围，没有获得部署、模型切换、质量门槛或价格口径的批准。

## 检索记录

外部访问均使用 smart-search CLI。原有三名只读子代理分别核查 TypeSafe/AutoTrust、NLI 和 Qwen；主代理点验关键原文，并沿 27B 模型卡链接补充核实 9B 和 NeoHorse 4B 的原始模型卡及部署说明。没有下载权重或真实调用模型。

```sh
smart-search fetch 'https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/local-neohorse-4b-source.md
smart-search fetch 'https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B/blob/main/DEPLOYMENT.md' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/local-neohorse-4b-deployment.md
smart-search fetch 'https://huggingface.co/autotrust/JEV-9B' --format markdown --output .trellis/tasks/10-15-jev-batch-evaluation/research/local-jev-9b-source.md
smart-search fetch 'https://huggingface.co/autotrust/JEV-27B' --format markdown --output /tmp/11jev-local-jev-autotrust.md
smart-search fetch 'https://huggingface.co/Qwen/Qwen3.5-2B' --format markdown --output /tmp/11jev-local-smallllm-qwen35-2b.md
smart-search fetch 'https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli' --format markdown --output /tmp/11jev-local-nli-readme.md
```

部分发现检索遇到上游限额或缺配置，结论以成功获取的官方/发布者原文为依据；未声称已完成整个生态的穷尽检索。
