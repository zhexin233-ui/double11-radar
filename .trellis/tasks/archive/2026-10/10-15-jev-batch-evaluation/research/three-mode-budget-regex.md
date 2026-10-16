# 最终技术证据：预算与正则线程

日期：2026-10-16。用户已确定全局规则。两个只读探子核查官方 TypeSafe API/SDK 与 Node worker 文档；主代理点验 API 错误表并自行制定设计。未真实调用模型或运行规则性能基准。

## TypeSafe 输入预算

- [官方 API](https://docs.typesafe.ai/api.md) 的错误表写明：400 中 max_tokens_exceeded 表示超过模型上下文；413 表示 HTTP body 超过 32 MiB，不能视作 Token 超限。
- [官方索引](https://docs.typesafe.ai/llms.txt) 与公开 JS/Python SDK 参考中未找到可核实的 tokenizer、独立 Token 计数接口或精确发送前预检。
- 官方指向的 JS SDK v0.6.0 client.ts 在 systemOne 中校验问题结构后直接 POST，并无 Token 计算。[SDK 源码](https://github.com/typesafe-ai/typesafe-sdk-js/raw/refs/tags/v0.6.0/src/client.ts)。这不是对服务内部能力的穷尽证明。
- API 文档没有承诺超限标志的固定 JSON 字段路径，APIError.body 为 unknown。现本地 client.ts 的非2xx只保留 usage/model 与 HTTP 状态，不需为了首版回退功能猜测错误字段。
- 设计选择：稳定顺序装箱，每子批最多20条、完整门控请求16KiB；不能装入的单条直接逐条。它是保守启发保护，不是 Token 精确上界。一次真实门控失败全部回退，避免依赖未核实的字段解析。需要专项二分优化时另立证据后再改。
- not_sent 的 busy/cooldown/no_key 保持等待；实际429/529回退成员任务后仍遵守全局退避，不能立即连发绕限流。

## 正则执行

- [Node 22 worker_threads](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html) 支持独立线程、execArgv、resourceLimits 与 terminate。online 仅表示开始执行 JS，不等于初始化完成；需要显式 ready。
- resourceLimits 只约束部分 JS 引擎资源，不是 CPU 硬限或整个进程内存沙箱；terminate 异步，不能创建无限替代线程。
- 设计选择：固定 .mjs 脚本、消息传规则和文本、不执行用户代码；一个后台进程最多一个活跃线程；固定 iu；规则20条×500 UTF-16单元、合计16KiB。
- 初始保护预算为 ready 2秒、单命令500ms、等待空闲100ms；单文本64Ki UTF-16、单命令512Ki输入；超时/超长/协议不完整全部 fallback，不截断后过滤。
- 原生 JS 正则功能较完整，兼容性由 Node 22 引擎决定；这不是匹配质量或耗时保证。真实规则 runner 可注入，少量真实线程测试验证生命周期，常规流程测试使用 fake runner。
- 所有数字为技术起点，不是 NAS 测量结果；实施可依据同语义测试调整并记录，不增用户模式或改变过滤语义。

## 证据与复现

原始抓取保留于 /tmp/11jev-three-mode-budget-*、/tmp/11jev-three-mode-regex-*。本任务目录保存设计必需结论和官方来源，不依赖临时文件存在才能理解契约。

```sh
smart-search fetch 'https://docs.typesafe.ai/api.md' --format markdown --output /tmp/11jev-three-mode-budget-api-md.md
smart-search fetch 'https://docs.typesafe.ai/llms.txt' --format markdown --output /tmp/11jev-three-mode-budget-index.md
smart-search fetch 'https://nodejs.org/docs/latest-v22.x/api/worker_threads.html' --format markdown --output /tmp/11jev-three-mode-regex-node22-worker.md
```

公开资料不足的边界已明确处理为保守拆分与失败回退，不阻塞当前 MVP，也不声称掌握精确 Token 预算。没有新待问产品问题。
