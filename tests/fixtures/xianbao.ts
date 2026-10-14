/**
 * 线报酷真实响应 fixture（依据 research/xianbao-live-samples.md 的实测结构）。
 * 仅用于固定样例测试；这是 mock 数据，不代表真实接口已端到端验证。
 */

export const META_RESPONSE = {
  code: 0,
  msg: "",
  data: {
    abilities: {
      feed: {
        endpoint: "/api/v1/feed",
        params: {
          cate: "分类别名或 ID，缺省=all（全站流）",
          type: "填 zdm 取值得买独立流",
          limit: "1~50，默认 20",
        },
        categories: [
          { alias: "haodan", id: 30, name: "好单线报", has_price: true, rows_now: 20 },
          { alias: "weibo", id: 10, name: "微博线报", has_price: true, rows_now: 20 },
          { alias: "zhidemai", id: 19, name: "值得买", has_price: false, rows_now: 0 },
          { alias: "kuan", id: 17, name: "酷安", has_price: false, rows_now: 17 },
        ],
      },
    },
    rate_limit: {
      limit: 60,
      window_seconds: 60,
      scope: "per IP, per endpoint",
      headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"],
    },
  },
  meta: { api_version: "v1", generated_at: 1791909784, cache_ttl: 600 },
};

export const FEED_HAODAN_RESPONSE = {
  code: 0,
  msg: "",
  data: {
    type: "post",
    category: { id: 30, alias: "haodan", name: "好单线报" },
    count: 2,
    items: [
      {
        id: 7208398,
        title: "稻香村蛋黄酥糕点礼盒点心 3.5元",
        content: "叠金币拍2件 稻香村蛋黄酥糕点礼盒点心",
        url: "https://new.xianbao.fun/haodan/7208398.html",
        category: { id: 30, name: "好单线报-食品-淘宝" },
        price: 3.5,
        published_at: 1791909780,
        published_text: "2026-10-14 00:43",
        author: "发报员T",
        comments: 0,
      },
      {
        id: 7208396,
        title: "心相印超韧抽纸 24包",
        content: "心相印超韧抽纸 24包 9.9元包邮",
        url: "https://new.xianbao.fun/haodan/7208396.html",
        category: { id: 30, name: "好单线报-日用-天猫" },
        price: 9.9,
        published_at: 1791909727,
        published_text: "2026-10-14 00:42",
        author: "发报员Z",
        comments: 0,
      },
    ],
  },
  meta: { api_version: "v1", generated_at: 1791909805, cache_ttl: 10 },
};

/** 第三批：新增一条线报，用于验证只有新条目入队。 */
export const FEED_HAODAN_NEW_ITEM = {
  id: 7208399,
  title: "维达软抽家庭装 6包",
  content: "维达软抽家庭装 6包 19.9元",
  url: "https://new.xianbao.fun/haodan/7208399.html",
  category: { id: 30, name: "好单线报-日用-京东" },
  price: 19.9,
  published_at: 1791909800,
  published_text: "2026-10-14 00:44",
  author: "发报员Z",
  comments: 0,
};

export const FEED_WEIBO_PRICE_NULL = {
  code: 0,
  msg: "",
  data: {
    type: "post",
    category: { id: 10, alias: "weibo", name: "微博线报" },
    count: 1,
    items: [
      {
        id: 7208400,
        title: "反18.6 15块钱12瓶 我觉得也可以",
        content: "反18.6 15块钱12瓶",
        url: "https://new.xianbao.fun/weibo/7208400.html",
        category: { id: 10, name: "微博线报" },
        price: null,
        published_at: 1791909800,
        published_text: "2026-10-14 00:43",
        author: "欧皇呀ing",
        comments: 0,
      },
    ],
  },
  meta: { api_version: "v1", generated_at: 1791909819, cache_ttl: 10 },
};

export const ZDM_RESPONSE = {
  code: 0,
  msg: "",
  data: {
    type: "zdm",
    label: "值得买",
    count: 1,
    items: [
      {
        id: "183926744",
        type: "smzdm",
        title: "BOP 抗菌肽色修美白牙膏 6.99元",
        url: "https://www.smzdm.com/p/183926744/",
        price: 6.99,
        brand: "BOP/波普专研",
        mall: "京东",
        category_name: "个护化妆/口腔护理/牙膏",
        pic: "https://y.zdmimg.com/example.jpg",
        published_at: 1791909738,
      },
    ],
  },
  meta: {
    api_version: "v1",
    generated_at: 1791909819,
    cache_ttl: 10,
    note: "值得买为独立数据源，字段与分类流不同（见字段字典）",
  },
};

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
