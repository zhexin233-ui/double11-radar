# Jev接口兼容性核验

日期：2026-10-13。用户要求查jev是否支持OpenAI兼容接口，支持则使用。尚未提供正在使用的服务网址。不能仅凭jev名称认定具体模型。

后续决定：用户已明确所指为TypeSafe Jev。当前设计采用原生System One API；AutoTrust JEV-27B仅保留为名称辨识的历史研究，不是本期接入对象。

## 结论

查到两个不同提供方的模型：

| 对象 | 已核验协议 | 结论 |
| --- | --- | --- |
| TypeSafe Jev（jev-latest） | POST https://api.typesafe.ai/v1/systemone，state/model/questions → answers | 官方公开的是原生System One协议，未找到OpenAI Chat Completions兼容接口；不生成自由文本 |
| AutoTrust autotrust/JEV-27B | vLLM OpenAI服务器；POST /v1/chat/completions，model/messages → choices | System 2文本生成路径支持OpenAI兼容调用；System 1决策另有/v1/decide与特殊logprobs/校准处理，不等同一般聊天请求 |

用户现已确认使用TypeSafe Jev，采用原生System One API。尚未做带凭据连接测试，不确认账号权限、价格或推送效果；AutoTrust托管地址不属于当前接入范围。

## TypeSafe官方证据

主代理直接fetch并阅读全文：

- https://docs.typesafe.ai/api.md ：“Evaluate a state against a map of typed questions and get back structured answers”；端点 /v1/systemone；请求state/model/questions，返回model/answers/usage，三种类型noul/choice/score。
- https://docs.typesafe.ai/introduction/coding-agents.md ：“Jev is not a chat or code-completion LLM”；“It does not generate text, write code, or hold a conversation.”

两个探子从jev-router、jev-ultrafast、jev-feels、duckdb-jev等候选README追溯到TypeSafe，并核验官方简介、快速开始与文档索引。第三方项目调用OpenAI文本helper不能证明TypeSafe Jev自身兼容。

若选TypeSafe：按每个需求构造Choice问题，候选matched/not_matched/uncertain，仅matched进入通知。其结构化分类适合此目标，但不能让其直接生成此前草案中的商品名称、规格、原文摘录或自由文本理由；页面可显示分类结果与明确标注的程序模板说明。是否需要额外抽取/解释模型应另行决定，不能静默扩展首版模型链路。

## AutoTrust官方模型卡与项目证据

主代理直接fetch：

- https://huggingface.co/autotrust/JEV-27B ：模型卡明确“Two models, two organisations”：TypeSafe Jev是TypeSafe闭源托管模型；autotrust/JEV-27B为AutoTrust独立模型。使用说明标题“Start the server (OpenAI-compatible)”，说明serve_decide.py是标准vLLM OpenAI服务器并增加/v1/decide。System 2调用例为POST localhost:8000/v1/chat/completions，model为autotrust/JEV-27B，messages为用户输入。
- https://github.com/yuhai-china/JEV-27B-DEMO ：README说明同一引擎提供System 1决策与System 2生成；提供托管服务示例与独立部署说明。未因此认定用户已有托管服务账号。
- https://raw.githubusercontent.com/yuhai-china/JEV-27B-DEMO/master/common/jev_client.py ：chat_raw()注明“System 2, full OpenAI-style response”；body包含model/messages/max_tokens/temperature，POST {URL}/v1/chat/completions；reply_parts()读取choices[0].message.content。decide()路径不同，需区分。

若选JEV-27B：可按OpenAI兼容聊天接口接入，但匹配结果依旧需验证结构，不能仅凭聊天文本宣称明确命中。模型推理服务部署与NAS应用部署是不同事项，本任务尚未要求在NAS运行27B模型本体。

## 检索过程与限制

初次smart-search search 90秒超时；180秒重试成功，但综合回答起初把两款模型合并叙述，且没有primary_sources。主代理依据候选URL实际fetch后明确区分身份与两条接口路径。EXA未配置；doctor与diagnose显示主链路有间歇超时、文档抓取可用。未修改用户的搜索配置，不保存或打印真实密钥。

## 关键复现命令

```sh
smart-search search 'jev LLM 模型 API OpenAI 兼容接口 官方' --extra-sources 1 --timeout 90 --format json --output /tmp/11jev-model-compat-search.json
smart-search search 'jev LLM 模型 API OpenAI 兼容接口 官方' --extra-sources 1 --timeout 180 --format json --output /tmp/11jev-model-compat-retry2.json
smart-search context7-library 'jev' 'Jev LLM API OpenAI compatible chat completions' --format json --output /tmp/11jev-model-context7.json
smart-search fetch 'https://docs.typesafe.ai/api.md' --format markdown --output /tmp/11jev-typesafe-api.md
smart-search fetch 'https://docs.typesafe.ai/introduction/coding-agents.md' --format markdown --output /tmp/11jev-typesafe-role.md
smart-search fetch 'https://github.com/yuhai-china/JEV-27B-DEMO' --format markdown --output /tmp/11jev-27b-candidate.md
smart-search fetch 'https://raw.githubusercontent.com/yuhai-china/JEV-27B-DEMO/master/common/jev_client.py' --format markdown --output /tmp/11jev-27b-client.md
smart-search fetch 'https://huggingface.co/autotrust/JEV-27B' --format markdown --output /tmp/11jev-27b-model.md
```
