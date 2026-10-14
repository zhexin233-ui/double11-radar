# 飞书通知接入研究

日期：2026-10-13。由单轮探子 `feishu_channel` 通过 smart-search CLI 阅读官方文档并交回。主代理据出处整理；未登录创建机器人、未发送真实消息，签名向量及端到端送达尚未实测。

## 已核验事实

自定义群机器人适合简单群通知：获取 Webhook 后 POST，消息只发送到机器人所属群，不支持单聊或跨群复用。无需应用发布审核。飞书应用机器人可给指定用户或群发消息，但需要创建应用、启用机器人、权限与发布流程，且受应用可用范围、群权限约束。

用户已确认第一版采用自定义群机器人。网页必填 Webhook URL；如开启签名需保存 signing secret。如开启关键词校验，通知标题/文本必须含约定关键词，可配置固定前缀。IP白名单在飞书侧设置，需要匹配服务出口IP。

推荐发送 `msg_type=post` 富文本，使用 `tag=a`、`text`、`href` 节点提供“查看原始线报”链接。不能把 Markdown `[文字](URL)` 在自定义机器人 text 消息里的可点击效果当作已支持事实。

## 签名与业务成功

签名关键原文（自定义机器人指南，Method 3）：

> `timestamp + "\n" + secret key` … the signature result of the empty string is calculated using the HmacSHA256 algorithm, and then Base64 encoding is performed.

具体含义：UTF-8 `timestamp + LF + signing_secret` 为 HMAC key，message 为空，SHA-256 再 Base64；秒级 timestamp 和 sign 放在请求体顶层，时间偏差不得超过3600秒。不是对正文做签名，也不是 secret 为 key、timestamp 为 message。

返回成功例 `{"code":0,"data":{},"msg":"success"}`。必须同时检查HTTP与业务结果，不能仅以HTTP200标记成功。签名失败19021、IP失败19022、关键词失败19024、限流可能11232。非零业务码应记录并区别可重试/配置错误；接口成功不能证明用户已收到设备通知或已读。

文档给出自定义机器人频控单租户单机器人100次/分钟、5次/秒，请求体≤20KB。应队列发送并控制大小，具体实现时重新核对当前官方限制。

Webhook文档未找到等效业务幂等字段；超时后重发可能重复，不能承诺恰好一次。自建应用有uuid幂等机制，但不能套在Webhook上。

## 协议边界

群Webhook的 `content` 是对象；应用发消息API的 `content` 是JSON序列化字符串，不能直接复用载荷。群Webhook不需要app_id、app_secret、用户ID或群ID。应用路线需要这些相应配置，并在服务端获取tenant_access_token，而非要求用户手动维护短期token。

## 官方来源

- 自定义机器人：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
- 机器人概述：https://open.feishu.cn/document/client-docs/bot-v3/bot-overview
- 应用发送消息：https://open.feishu.cn/document/server-docs/im-v1/message/create
- 自建应用token：https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal
- 消息内容结构：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json

探子报告上述页面全部fetch成功，抓取正文为英文。个人账号是否能创建所需群/应用、用户权限和客户端通知效果未实测。

## 复现命令

```sh
smart-search context7-library 'feishu open platform' 'custom bot webhook send message signature app message' --format json
smart-search context7-docs '/websites/open_feishu_cn_document' '应用机器人 发送消息 POST im v1 messages receive_id_type tenant_access_token app_id app_secret text hyperlink 自定义机器人 签名 hmac sha256' --format json
smart-search context7-docs '/websites/open_feishu_cn_document' '自定义机器人 Python gen_sign string_to_sign hmac.new digestmod sha256 文本消息 超链接 URL' --format json
smart-search fetch 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot' --format markdown
smart-search fetch 'https://open.feishu.cn/document/client-docs/bot-v3/bot-overview' --format markdown
smart-search fetch 'https://open.feishu.cn/document/server-docs/im-v1/message/create' --format markdown
smart-search fetch 'https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal' --format markdown
smart-search fetch 'https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json' --format markdown
```
