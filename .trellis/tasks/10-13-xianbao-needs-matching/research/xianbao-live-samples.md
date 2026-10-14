# 线报酷 API 实测响应（2026-10-13 主代理 curl 实测）

原规划的 smart-search fetch 未能提取 meta；本文件是主代理直接 HTTP 实测的原始结构，作为采集适配器与固定样例测试的唯一依据。全部为公开只读数据，无凭据。

实测命令：

```sh
curl -sS "https://new.xianbao.fun/api/v1/meta"
curl -sS "https://new.xianbao.fun/api/v1/feed?cate=haodan&limit=3"
curl -sS "https://new.xianbao.fun/api/v1/feed?type=zdm&limit=3"
curl -sS "https://new.xianbao.fun/api/v1/feed?limit=2"
```

## 1 统一外层信封

所有接口返回 `{ code, msg, data, meta? }`：

- `code: 0` 表示成功；非 0 必须按业务失败处理（不能只看 HTTP 200）。
- `msg` 为字符串（成功时为空串）。
- `meta: { api_version: 'v1', generated_at: <unix秒>, cache_ttl: <秒>, note? }`。

注意 `cache_ttl` 是**该响应自身**的缓存秒数：
- `/api/v1/meta`：`cache_ttl = 600`（meta 本身 10 分钟内可缓存）。
- `/api/v1/feed`：`cache_ttl = 10`（feed 建议 10 秒轮询，与文档一致）。

## 2 `/api/v1/meta` 实测结构

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "abilities": {
      "rank": { "endpoint": "/api/v1/rank", "params": {...}, "ranks": [...] },
      "feed": {
        "endpoint": "/api/v1/feed",
        "params": {
          "cate": "分类别名或 ID，缺省=all（全站流）",
          "type": "填 zdm 取值得买独立流",
          "limit": "1~50，默认 20"
        },
        "categories": [
          { "alias": "zuankeba", "id": 16, "name": "赚客吧", "has_price": false, "rows_now": 3 },
          { "alias": "haodan", "id": 30, "name": "好单线报", "has_price": true, "rows_now": 20 },
          { "alias": "weibo", "id": 10, "name": "微博线报", "has_price": true, "rows_now": 20 },
          { "alias": "zhidemai", "id": 19, "name": "值得买", "has_price": false, "rows_now": 0 }
        ]
      },
      "search": { "endpoint": "/api/v1/search", "params": {...}, "price_scope": [...] },
      "shenghuo": { "endpoint": "/api/v1/shenghuo", "params": {...} }
    },
    "not_provided": [ {"feature": "...", "reason": "..."} ],
    "rate_limit": {
      "limit": 60,
      "window_seconds": 60,
      "scope": "per IP, per endpoint",
      "headers": ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]
    },
    "notes": ["..."]
  },
  "meta": { "api_version": "v1", "generated_at": 1791909784, "cache_ttl": 600 }
}
```

实测共 **21 个 feed 分类**。完整别名清单（实测）：

| alias | id | name | has_price |
| --- | --- | --- | --- |
| zuankeba | 16 | 赚客吧 | false |
| haodan | 30 | 好单线报 | true |
| xinzuanba | 18 | 新赚吧 | false |
| xiaodigu | 11 | 小嘀咕 | false |
| weibo-chaohua | 14 | 微博超话 | false |
| weibo | 10 | 微博线报 | true |
| douban | 23 | 豆瓣线报 | false |
| douban-maizu | 24 | 豆瓣线报-买组 | false |
| douban-pinzu | 25 | 豆瓣线报-拼组 | false |
| douban-fazu | 22 | 豆瓣线报-发组 | false |
| douban-maolife | 27 | 豆瓣线报-爱猫生活 | false |
| douban-maobathtub | 28 | 豆瓣线报-爱猫澡盆 | false |
| douban-gouzu | 31 | 豆瓣线报-狗组 | false |
| zhidemai | 19 | 值得买 | false |
| kuan | 17 | 酷安 | false |
| huluxia | 20 | 葫芦侠三楼 | false |
| man | 21 | 更新较慢活动 | false |
| xiaodao | 3 | 小刀娱乐网 | false |
| iqnew | 4 | 爱Q生活网 | false |
| mianfei | 9 | 免费赚钱中心 | false |
| zdm | 19 | 值得买（独立数据源） | true |

**关键约束**：`zhidemai`(alias, id 19, 分类流) 与 `zdm`(alias, id 19, 独立数据源) 覆盖同一批值得买内容。逐频道调度时**必须排除 `zhidemai` 分类流**，只使用 `type=zdm` 独立流，否则同一内容会被两套编号空间重复采集。`zdm` 条目的 `note` 明确写「独立数据源，字段与分类流不同，请求 /api/v1/feed?type=zdm」。

**不要**轮询 `all`（缺省）：实测 all 流的 items 混入各频道内容（如 weibo-chaohua、haodan），与逐频道轮询重叠，且 `category.id=0` 不是真实频道。

## 3 普通分类流实测 item 结构

`GET /api/v1/feed?cate=haodan&limit=3`：

```json
{
  "code": 0, "msg": "",
  "data": {
    "type": "post",
    "category": { "id": 30, "alias": "haodan", "name": "好单线报" },
    "count": 3,
    "items": [
      {
        "id": 7208398,
        "title": "稻香村蛋黄酥糕点礼盒点心 3.5元",
        "content": "𝑩𝒖𝒈‼️叠金币拍2件💰3.5稻香村蛋黄酥糕点礼盒点心下单:‼️快快快蛋黄酥💰1一盒",
        "url": "https://new.xianbao.fun/haodan/7208398.html",
        "category": { "id": 30, "name": "好单线报-食品-淘宝" },
        "price": 3.5,
        "published_at": 1791909780,
        "published_text": "2026-10-14 00:43",
        "author": "发报员T",
        "comments": 0
      }
    ]
  },
  "meta": { "api_version": "v1", "generated_at": 1791909805, "cache_ttl": 10 }
}
```

- `id` 为数字；`price` 可为 `null`（实测 all 流中的 weibo-chaohua 条目 `price: null`）；无价格字段 `has_price:false` 的频道也会给 `price`（可能为 null）。
- `category.name` 是细分品类（如「好单线报-食品-淘宝」），可作为 Jev 的 `品类` 输入；`category.id` 等于请求频道 id。
- `published_at` 为 Unix 秒；`published_text` 为可读文本。
- `content` 实测存在（分类流始终返回正文纯文本）。

## 4 值得买独立流实测 item 结构

`GET /api/v1/feed?type=zdm&limit=3`：

```json
{
  "code": 0, "msg": "",
  "data": {
    "type": "zdm", "label": "值得买", "count": 3,
    "items": [
      {
        "id": "183926744",
        "type": "smzdm",
        "title": "BOP 抗菌肽色修美白牙膏... 6.99元",
        "url": "https://www.smzdm.com/p/183926744/",
        "price": 6.99,
        "brand": "BOP/波普专研",
        "mall": "京东",
        "category_name": "个护化妆/口腔护理/牙膏",
        "pic": "https://y.zdmimg.com/...jpg",
        "published_at": 1791909738
      }
    ]
  },
  "meta": { "api_version": "v1", "generated_at": 1791909819, "cache_ttl": 10, "note": "值得买为独立数据源，字段与分类流不同（见字段字典）" }
}
```

- `id` 为**字符串**（站外 smzdm 编号），与普通流数字 id 不是同一编号空间。
- **无 `content`、无 `category` 对象**；额外有 `brand`、`mall`、`category_name`、`pic`、`type:'smzdm'`。
- `url` 指向 smzdm.com，不是 xianbao.fun。
- `price` 实测为数字；字段缺失时按 null。

## 5 采集适配必须据此实现的点

1. 先校验外层 `code === 0`，再读 `data`。
2. feed 与 zdm 用**两套独立 zod schema 与两个 normalize 函数**，不共用 item 解析。
3. `sourceNs`：feed 用 `feed:<channelAlias>`；zdm 用 `zdm`。`sourceId`：feed 用字符串化数字 id，zdm 用站外字符串 id。
4. 普通流 `content` 取 `data.items[].content`；zdm `content` 固定 null。
5. `price`：仅当为有限数字时取数值，`null`/缺失/NaN 一律 null，绝不用 0 代替。
6. `category`（feed）：优先用 `item.category.name`（细分品类），回退 `data.category.name`。
7. `publishedAt`：Unix 秒 → UTC ISO8601（`new Date(sec*1000).toISOString()`）。
8. 逐频道 `cache_ttl` 用 feed 响应的 `meta.cache_ttl`（实测 10 秒）作为轮询下限；meta 自身按 600 秒缓存。
9. 限流：60 次/分钟/IP/接口。只对 feed 接口计数；全局限流预算需保守（频道数 × 轮询频率 < 60/分钟/接口），必要时把每频道轮询间隔抬到 `max(cache_ttl, ceil(60/频道数)秒)` 以上，并对 429 按 `Retry-After` 退避。
10. `zhidemai` 分类流在同步 meta 时必须跳过（见第 2 节）。
