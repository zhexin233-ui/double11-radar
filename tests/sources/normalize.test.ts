import { describe, expect, it } from "vitest";
import {
  fromUnixSeconds,
  normalizeFeedItems,
  normalizeZdmItems,
  toPrice,
} from "@/lib/sources/xianbao/normalize";
import {
  FEED_HAODAN_RESPONSE,
  FEED_WEIBO_PRICE_NULL,
  ZDM_RESPONSE,
} from "../fixtures/xianbao";

describe("采集归一化（真实样例 fixture，mock 验证）", () => {
  it("普通分类流：细分品类、价格、发布时间与编号空间", () => {
    const items = normalizeFeedItems(FEED_HAODAN_RESPONSE.data, {
      id: "haodan",
      alias: "haodan",
      origin: "feed",
    });
    expect(items).toHaveLength(2);
    const first = items[0];
    expect(first.sourceNs).toBe("feed:haodan");
    expect(first.sourceId).toBe("7208398");
    expect(first.category).toBe("好单线报-食品-淘宝");
    expect(first.price).toBe(3.5);
    expect(first.publishedAt).toBe("2026-10-13T16:43:00.000Z");
    expect(first.content).toContain("稻香村");
  });

  it("价格缺失为 null，绝不用 0 代替", () => {
    const items = normalizeFeedItems(FEED_WEIBO_PRICE_NULL.data, {
      id: "weibo",
      alias: "weibo",
      origin: "feed",
    });
    expect(items[0].price).toBeNull();
  });

  it("值得买独立流：字符串 id、无正文、独立编号空间", () => {
    const items = normalizeZdmItems(ZDM_RESPONSE.data);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.sourceNs).toBe("zdm");
    expect(item.sourceId).toBe("183926744");
    expect(item.content).toBeNull();
    expect(item.category).toBe("个护化妆/口腔护理/牙膏");
    expect(item.brand).toBe("BOP/波普专研");
    expect(item.mall).toBe("京东");
    expect(item.url).toContain("smzdm.com");
  });

  it("结构与内容版本稳定可复现", () => {
    const a = normalizeFeedItems(FEED_HAODAN_RESPONSE.data, {
      id: "haodan",
      alias: "haodan",
      origin: "feed",
    });
    const b = normalizeFeedItems(FEED_HAODAN_RESPONSE.data, {
      id: "haodan",
      alias: "haodan",
      origin: "feed",
    });
    expect(a[0].contentVersion).toBe(b[0].contentVersion);
    expect(a[0].contentVersion).toHaveLength(16);
  });

  it("边界工具：非法时间与非法价格归一为 null", () => {
    expect(fromUnixSeconds(0)).toBeNull();
    expect(fromUnixSeconds(null)).toBeNull();
    expect(fromUnixSeconds(Number.NaN)).toBeNull();
    expect(toPrice(Number.NaN)).toBeNull();
    expect(toPrice(null)).toBeNull();
    expect(toPrice(0)).toBe(0);
  });

  it("结构不符合预期时返回空数组而不抛异常", () => {
    expect(normalizeFeedItems({ items: "nope" }, { id: "x", alias: "x", origin: "feed" })).toEqual([]);
    expect(normalizeZdmItems(null)).toEqual([]);
  });
});
