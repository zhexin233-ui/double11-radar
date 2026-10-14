# 首版通知渠道比较

日期：2026-10-13。用户问“推送到哪里比较合适？”，尚未选定渠道或提供手机系统。

后续决定：用户已明确首版支持Bark和飞书，并要求通过网页配置；以下单渠道建议属于此前讨论，已由当前设计替代，不再是首版范围。当前飞书接入证据见 `feishu-notifications.md`。

## 已核验的事实

- Bark 官方仓库 https://github.com/Finb/Bark 的说明：iOS/iPhone 自定义通知工具，支持 GET/POST 发送、`url` 点击跳转、`group` 分组，以及自建服务。直接适配“抽纸命中提醒 → 点击原始线报链接”的需求。
- pushplus 官方实名认证说明 https://www.pushplus.plus/doc/function/verify.html：未实名不能使用发送消息接口，API调用亦适用；认证存在费用。不能建议成无需配置、完全免费的微信发送通道。
- 线报酷 pushplus 教程 https://new.xianbao.fun/docs/2zv09.html 提供微信通知渠道与 Token 配置，但新旧教程段落混杂，会员、Windows挂机等旧版线报酷前提不能套在我们自建应用直接调用服务的路径上。具体额度应后续核验 pushplus 自身最新文档，本次不把第三方站点额度当承诺。
- 线报酷 Bark 教程此次 fetch 未返回内容（退出码4），因此改为 fetch Bark 官方仓库。未用其他联网工具绕过 smart-search。

## 建议，不是已决定范围

- iPhone：优先 Bark，手机直接通知并支持点击原始链接，首版交互简单。
- 希望完全在微信收消息：可选微信通知服务，例如 pushplus，但应接受该服务的实名认证、配置和额度约束。
- 若日常已有 Telegram：可以作为候选；本次未核验其API，不据此承诺交互按钮、延迟或投递保证。
- 第一版只接一种渠道，避免把多个通知服务的账号配置纳入首版。

下一步最高价值问题：用户用 iPhone 还是安卓。设备类型决定 Bark 是否适用，之后再确认渠道选择。

## 复现命令

```sh
smart-search fetch 'https://new.xianbao.fun/docs/coxjg.html' --format markdown --output /tmp/11jev-bark-channel.md
smart-search fetch 'https://new.xianbao.fun/docs/2zv09.html' --format markdown --output /tmp/11jev-pushplus-channel.md
smart-search fetch 'https://github.com/Finb/Bark' --format markdown --output /tmp/11jev-bark-official.md
smart-search fetch 'https://www.pushplus.plus/doc/function/verify.html' --format markdown --output /tmp/11jev-pushplus-official.md
```
