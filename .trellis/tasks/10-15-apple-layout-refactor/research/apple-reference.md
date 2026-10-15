# Apple 风格参考依据

调研日期：2026-10-15。

## 官方证据

已通过 `smart-search fetch` 成功读取 [Apple Human Interface Guidelines — Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。

复现命令：

```sh
smart-search fetch 'https://developer.apple.com/design/human-interface-guidelines/layout' --format markdown --output /tmp/11jev-apple-layout.md
```

原文与本项目可采用的规则：

| 官方原文 | 项目应用建议 |
| --- | --- |
| “Order content by relative importance.” | 状态页先显示健康与异常；页面主操作靠近标题区 |
| “Align elements to make them easier to scan…” | 导航、标题、工具栏、表格建立一致对齐规则 |
| “Group related items…” | Jev 连接、密钥、费用、试判按任务分组；用留白与分隔表达关系 |
| “Use progressive disclosure…” | 次要说明和低频设置可以渐进展示；异常和关键费用提示应直接可见 |
| “Design a layout that adapts gracefully and consistently.” | 根据可用宽度改变布局，桌面与窄屏保留同一任务能力 |
| “Be prepared for text-size changes.” | 长文案和放大文字不能截断关键操作或覆盖内容 |
| “Keep functionality the same as size classes change…” | 窄屏可以收起导航或局部滚动，但不删除配置与重试操作 |

以上是原则参考。具体颜色、尺寸、组件边界与导航选择是项目设计决定，不宣称由 Apple 直接规定。
官方页面还介绍原生平台 Liquid Glass；是否在网页采用轻量透明层应由可读性与性能决定，尚未形成需求。

## 官网展示结构参考

用户选择官网式方向后，通过以下命令成功读取 [Apple 中国 Mac 页面](https://www.apple.com/cn/mac/) 的文本结构：

```sh
smart-search fetch 'https://www.apple.com/cn/mac/' --format markdown --output /tmp/11jev-apple-mac-reference.md
```

获取内容包含“全系产品细细看”“用 Mac 显身手”“来了解一下 Mac”等独立主题及各自的短标题/说明，可作为主题分区和标题节奏的参考。
文本抓取不能证实实际颜色、字号、间距、动效或断点；本任务 `design.md` 的视觉参数是项目方案，未声称完成官网实屏对照。

## 检索限制

`smart-search exa-search` 因未配置 Exa key 失败；随后运行 `smart-search doctor --format json`，主搜索返回上游额度 HTTP 429，Tavily fetch 可用。因此本次直接读取已知官方页面；没有用其他检索工具绕行，也没有基于未获取内容作结论。
