# 本地语义模型：参数、CPU 与耗电边界

核验日期：2026-10-15。用户询问参数量、硬件和耗电，并未批准新增本地模型。本轮只读官方资料，不下载权重、不部署、不用当前开发电脑冒充用户 NAS。

## 已核实模型规格

| 模型 | 官方参数量 | 约合 B | 官方权重体积 | 输入限制 |
| --- | --- | --- | --- | --- |
| BAAI/bge-small-zh-v1.5 | 24M | 0.024B | 95.8 MB | 512 tokens |
| BAAI/bge-base-zh-v1.5 | 102M | 0.102B | 409 MB | 512 tokens |
| BAAI/bge-m3 | 569M | 0.569B | 2.27 GB | 8192 tokens |

官方参数是取整规格，不是逐个张量核算的精确整数。前两款为中文编码器，M3 为包含中文的多语言模型。权重体积不是运行内存，也不是显存或功耗。

来源：[BGE v1/v1.5 官方规格](https://bge-model.com/bge/bge_v1_v1.5.html)、[BGE-M3 官方规格](https://bge-model.com/bge/bge_m3.html)。前两款 512 位置上限另见 [small 配置](https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/main/config.json)、[base 配置](https://huggingface.co/BAAI/bge-base-zh-v1.5/blob/main/config.json) 的 `max_position_embeddings`。

这些是 embedding 编码器，输出向量；不能把它们当作已经适配需求/价格的业务分类器。需要额外相似度策略、分类层或其他经过验证的决策方式。低相似度不能直接证明不相关。长正文超限时须分段评估并核实聚合策略，不可为省资源静默截断正文而引入遗漏。

## CPU 运行与配置建议

[Sentence Transformers 官方效率指南](https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html) 支持 `device="cpu"`、ONNX `CPUExecutionProvider` 和 CPU 上的 OpenVINO。因此无须先购买独立显卡，但 NAS 的 CPU 架构、运行时包兼容与实际处理速度仍须核实。

以下为保守试运行余量建议，**不是官方最低配置，也不是本机/NAS 实测**。前提为兼容的现代 CPU、单进程、小批量；长文分段、并发和其他服务会增加需求。

| 模型档位 | 建议 CPU 起点 | 整机内存试运行起点 | 建议先留出的空闲内存 |
| --- | --- | --- | --- |
| 约 0.024B | 2 核 | 4 GB | 约 1 GB 以上 |
| 约 0.1B | 4 核 | 8 GB | 约 2 GB 以上 |
| 约 0.57B | 4–8 核 | 16 GB | 约 6–8 GB |

FP32 权重理论占用为参数量×4 字节，约 96 MB、408 MB、2.276 GB（十进制），实际进程还包含分词器、运行时、激活与缓冲；操作系统、数据库及其他 NAS 服务另计。不能由 B 数直接推出整机最低 RAM。

官方支持 ONNX 动态 INT8，预设涉及 arm64/AVX2/AVX512 等，必须匹配 CPU；OpenVINO 静态量化需校准数据。量化需复核过滤质量和真实速度，不能承诺恰好省四倍 RAM 或一定加速。[ONNX 官方量化指南](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html) 明确量化不是无损变换，旧设备也可能更慢。

没有查到可泛化到任意 NAS 的官方功耗或最低内存保证。Sentence Transformers 官方基准使用 i7-13700K，不能把其吞吐直接外推到低功耗 NAS。

## 耗电如何估计

实际功耗由 CPU、线程数、文本长度、需求数、运行时和处理时长决定。模型可常驻内存、仅有任务时执行，并不要求 CPU 全天满载；低流量不等于已知的平均新增瓦数，仍需实测。CPU TDP 用于散热设计，不能代替新增墙上功耗，参考 [Intel TDP 说明](https://www.intel.com/content/www/us/en/support/articles/000055611/processors.html)。

月新增用电示例：`平均新增功率(W) × 24 × 30 ÷ 1000`。

| 假设全天平均新增功率 | 每月新增用电 |
| --- | --- |
| 1 W | 0.72 kWh（度） |
| 5 W | 3.6 kWh（度） |
| 10 W | 7.2 kWh（度） |

这只是算术示例，**不是这些模型的实测或预测功率**。应使用插座电量计对比运行前后、相近 NAS 工作负载下的平均差值。硬盘活动和其他容器也会影响整机读数。

建议在已有 CPU 上试跑小档模型，测召回、吞吐、内存峰值和平均增量功率，再比较实际 JEV 账单；不为本阶段直接推荐购买 GPU，不能宣称新硬件能回本。

## 证据与检索记录

两名只读子代理分别核验官方模型卡和 CPU 运行/量化说明，主代理点验官方参数表与 CPU 运行段落。完整抓取保留于 `/tmp/11jev-hardware-models-*` 与 `/tmp/11jev-hardware-runtime-*`，仓库研究文件保留关键原文和来源。

- BGE 官方表：“BAAI/bge-small-zh-v1.5 | Chinese | 24M | 95.8 MB”；“BAAI/bge-base-zh-v1.5 | Chinese | 102M | 409 MB”。
- M3 官方表：“BAAI/bge-m3 | Multi-Lingual | 569M | 2.27 GB”；输入：“up to 8192 tokens”。
- CPU 指南：“The best backend depends on your hardware, model and input lengths.”

复现命令示例：

```sh
smart-search fetch 'https://bge-model.com/bge/bge_v1_v1.5.html' --format json --output /tmp/11jev-hardware-models-flag-models.json
smart-search fetch 'https://bge-model.com/bge/bge_m3.html' --format json --output /tmp/11jev-hardware-models-flag-m3.json
smart-search fetch 'https://www.sbert.net/docs/sentence_transformer/usage/efficiency.html' --format markdown --output /tmp/11jev-hardware-runtime-efficiency.md
smart-search fetch 'https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html' --format markdown --output /tmp/11jev-hardware-runtime-onnx-quant.md
```

辅助检索遇到 Exa 未配置及主搜索额度不足；参数与 CPU 结论依据已成功抓取的上述官方页面，不依据失败检索或生成摘要。没有更改搜索配置。

## 下一项用户信息

需要用户 NAS 的 CPU 型号与内存容量以判断试运行适配性。是否增加模型依赖、漏报目标、凑批等待及价格口径均尚未批准。
