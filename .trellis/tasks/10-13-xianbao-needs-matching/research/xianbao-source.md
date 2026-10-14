# 线报酷接入证据

核验日期：2026-10-13。全部外部页面通过 `smart-search fetch` 获取。探子提供定位，以下关键原文经主代理指定页面核验。尚未登录配置账户或运行产品接入。

## 公开 API

来源：https://new.xianbao.fun/docs/api-fields.html

官方当前字段字典说明，榜单/分类流/搜索记录有 `id`、`title`、绝对 `url`、`category`、`price`、`published_at`、`author`、`content` 等字段。

关键原文：

> `price`：数字或 null；null 表示该内容没有价格（与 0 元不同）。只有微博线报/好单线报/值得买有值。
> `content`：正文纯文本。分类流始终返回；榜单在 limit ≤ 50 时不返回。
> 出于安全考虑，不提供正文 HTML（含转链与图片的那一版）。需要跳转请用 url 字段。

值得买独立流 `type=zdm` 是另一种结构：字符串 `id`、站外 `url`（smzdm.com）、`title`、`price`、`brand`、`mall`、`category_name`、`pic`、`published_at`。不能按通用流结构强行解析，也不能假定有正文。

来源补充：https://new.xianbao.fun/docs/api-start.html 与 https://new.xianbao.fun/docs/api-limits.html，均已 fetch。

快速开始明确写道：“公开只读 API，无需申请密钥、无需登录”。提供 `/api/v1/meta`、`rank`、`feed`、`search`、`shenghuo` 五个接口；建议先读取 meta 获取当前有效参数。

限流页明确额度60次/分钟，按“IP+接口”计数；快速开始简述为每IP每分钟60次。应保守控制总请求量，以实际响应头与 meta 为准。429 按 `Retry-After` 等待；服务端缓存建议通过 `meta.cache_ttl` 获取（分类流示例为10秒），不写死。

关键原文：“SSE 实时推送流……不对外开放。需要实时性请以10秒间隔轮询 `/api/v1/feed`”。公开 API 也不提供用户私有筛选规则或有效/失效投票写入。

已确定文档层面的可行接入；当前 API 的真实返回、分页/补齐能力和目标频道覆盖尚待接口参考及实际集成验证。不把旧接口限制套在所有新接口上。

## 自定义 Webhook

来源：https://new.xianbao.fun/docs/ejioy.html

关键原文：

> 登录 → 推送渠道 → 新增推送渠道 → 类型选自定义 Webhook。
> 请求方式 GET / POST 可选；自定义推送地址、Headers、data 模板。
> 内容变量：{标题} {纯文字内容} {Html内容} {Markdown内容} {链接} {分类名} {分类ID} {日期} {时间} {楼主} {内容摘要}（前100字）{价格} {商城} {品牌} {图片}（值得买内容）。
> 云端直发由服务器发起、挂机由浏览器工作台+油猴脚本代发。

这是网站向用户自建接收服务发请求的出站通道，和自建应用在 LLM 判断后向用户发送通知是两段独立流程。应请求完整纯文字内容，不能只拿100字摘要。Webhook 权限与额度未在本轮主代理登录核验；探子定位的额度页仅作为候选证据：https://new.xianbao.fun/docs/hpkfl.html。

## 旧版值得买接口公告

来源：https://new.xianbao.fun/gonggao/3909547.html

关键原文：

> 最新15条值得买文章：https://new.xianbao.fun/plus/json/push_19.json；最快5秒请求一次，频繁获取封IP。
> 值得买1/3/6小时热帖：https://new.xianbao.fun/plus/json/rank/zhidemai-hot.json；最快300秒请求一次，频繁获取封IP。

此公告证明历史上有公开 JSON 拉取入口；最新15条窗口不能保证中断期间完整补齐。不得据此宣称全站所有线报均可覆盖。探子提到 `plus/json/push.json` 曾读取到数组，但其原始输出未交回，主代理未复核，不用于最终协议决策。

## 全部开放频道与快照限制（后续核验）

用户已选择网页可选频道、默认全部开放频道。主代理fetch官方接口参考 https://new.xianbao.fun/docs/api-reference.html ，关键原文：

> `/api/v1/meta`无参数，返回可订阅的分类、限流参数以及明确不提供的能力列表。
> `/api/v1/feed`的cate为分类别名或ID；缺省all；type=zdm取值得买独立流，字段结构不同。
> 每个分类流最多保留20条（值得买30条），是“最新快照”而不是可分页的历史接口。需要历史请用榜单接口。

因此不能把feed的limit最大50误解为能取50条历史，也不能写分页补齐快照的方案。应逐开放频道调度，加独立值得买流；聚合all流与各频道不能同时当成独立无重叠来源。榜单只提供热门历史，不等于完整历史备份；首版历史范围问题只能讨论首次可见快照或明确另行历史回放。

通过smart-search fetch https://new.xianbao.fun/api/v1/meta 获取原始JSON的尝试退出码4、无提取正文，未能用此抓取工具核验真实字段和值。当前能确认的是官方协议文档，实际meta响应需后续应用接入时检查，不把无内容推断为API不可用，也不猜完整分类枚举。

## 命令与证据文件

```sh
smart-search fetch 'https://new.xianbao.fun/docs/api-fields.html' --format markdown --output /tmp/11jev-xianbao-api-fields.md
smart-search fetch 'https://new.xianbao.fun/docs/ejioy.html' --format markdown --output /tmp/11jev-xianbao-webhook.md
smart-search fetch 'https://new.xianbao.fun/gonggao/3909547.html' --format markdown --output /tmp/11jev-xianbao-announcement.md
smart-search fetch 'https://new.xianbao.fun/docs/api-start.html' --format markdown --output /tmp/11jev-xianbao-api-start.md
smart-search fetch 'https://new.xianbao.fun/docs/api-limits.html' --format markdown --output /tmp/11jev-xianbao-api-limits.md
smart-search fetch 'https://new.xianbao.fun/docs/api-reference.html' --format markdown --output /tmp/11jev-xianbao-api-reference.md
smart-search fetch 'https://new.xianbao.fun/api/v1/meta' --format markdown --output /tmp/11jev-xianbao-meta.md
```

核心推论：语义匹配可以拿到标题与部分来源的正文/类目；品牌字段并非每条都有。只有品牌无具体品类时不能可靠确定是不是抽纸。
