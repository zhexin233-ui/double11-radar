import { describe, expect, it, vi } from "vitest";
import {
  fetchFeed,
  fetchMeta,
  XianbaoError,
  EXCLUDED_FEED_ALIASES,
} from "@/lib/sources/xianbao/client";
import { FEED_HAODAN_RESPONSE, META_RESPONSE, jsonResponse } from "../fixtures/xianbao";

describe("线报酷客户端", () => {
  it("meta 归一化开放频道并跳过 zhidemai/zdm 分类流、单独附加 zdm 独立流", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(META_RESPONSE));
    const meta = await fetchMeta({ baseUrl: "https://example.test", fetchImpl });
    const ids = meta.channels.map((c) => c.id);
    expect(ids).toContain("haodan");
    expect(ids).toContain("zdm");
    // 分类流不得包含 zhidemai / zdm，避免同一内容双编号空间重复采集
    const feedAliases = meta.channels
      .filter((channel) => channel.origin === "feed")
      .map((channel) => channel.id);
    for (const excluded of EXCLUDED_FEED_ALIASES) {
      expect(feedAliases).not.toContain(excluded);
    }
    // zdm 只出现一次，且为独立流
    expect(ids.filter((id) => id === "zdm")).toHaveLength(1);
    expect(meta.channels.find((c) => c.id === "zdm")?.origin).toBe("zdm");
    expect(meta.cacheTtlSeconds).toBe(600);
    expect(meta.rateLimit?.limit).toBe(60);
  });

  it("外层 code 非 0 视为业务失败", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 1001, msg: "boom", data: {} }),
    );
    await expect(
      fetchMeta({ baseUrl: "https://example.test", fetchImpl }),
    ).rejects.toBeInstanceOf(XianbaoError);
  });

  it("429 解析 Retry-After", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );
    await expect(
      fetchFeed(
        { id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 },
        { baseUrl: "https://example.test", fetchImpl },
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 30000 });
  });

  it("超时抛出带 status 0 的错误", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    await expect(
      fetchFeed(
        { id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 },
        { baseUrl: "https://example.test", fetchImpl, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("feed 使用 cate 参数，zdm 使用 type=zdm", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(FEED_HAODAN_RESPONSE);
    });
    await fetchFeed(
      { id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 },
      { baseUrl: "https://example.test", fetchImpl },
    );
    await fetchFeed(
      { id: "zdm", alias: "zdm", origin: "zdm" },
      { baseUrl: "https://example.test", fetchImpl },
    );
    expect(calls[0]).toContain("cate=30");
    expect(calls[1]).toContain("type=zdm");
  });
});

describe("线报酷网络失败信息同样中文化", () => {
  it("普通网络失败不回传英文原始信息", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    let message = "（未抛出错误）";
    try {
      await fetchFeed(
        { id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 },
        { baseUrl: "https://example.test", fetchImpl },
      );
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain("线报酷接口无法连接");
    expect(message).not.toContain("fetch failed");
  });
});

describe("分类数字 ID 与响应校验（R1/R2）", () => {
  it("能力清单保留数字 ID，字符串数字统一解析，缺失或非法 ID 拒绝同步", async () => {
    const meta = await fetchMeta({ fetchImpl: vi.fn(async () => jsonResponse(META_RESPONSE)) });
    expect(meta.channels.find(c => c.id === "haodan")?.categoryId).toBe(30);
    for (const id of [undefined, 0, -1, "weibo", "", 1.5]) {
      const body = structuredClone(META_RESPONSE);
      Object.assign(body.data.abilities.feed.categories[0], { id });
      await expect(fetchMeta({ fetchImpl: vi.fn(async () => jsonResponse(body)) }))
        .rejects.toThrow("有效数字分类 ID");
    }
    const body = structuredClone(META_RESPONSE);
    Object.assign(body.data.abilities.feed.categories[0], { id: "30" });
    expect((await fetchMeta({ fetchImpl: vi.fn(async () => jsonResponse(body)) })).channels[0].categoryId).toBe(30);
    await expect(fetchMeta({ fetchImpl: vi.fn(async () => jsonResponse({ code: 0, data: {} })) }))
      .rejects.toThrow("频道清单结构");
  });

  it.each([0, 10, undefined, "all"])("返回分类 %s 不得静默入库", async (id) => {
    const body = { ...FEED_HAODAN_RESPONSE, data: { ...FEED_HAODAN_RESPONSE.data, category: { id } } };
    await expect(fetchFeed({ id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 }, {
      fetchImpl: vi.fn(async () => jsonResponse(body)),
    })).rejects.toThrow("返回分类与请求不一致");
  });

  it("缺少分类 ID 时不发出请求；正确分类空列表仍成功", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...FEED_HAODAN_RESPONSE,
      data: { category: { id: "30" }, items: [] },
    }));
    await expect(fetchFeed({ id: "haodan", alias: "haodan", origin: "feed" }, { fetchImpl }))
      .rejects.toThrow("请刷新频道清单");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fetchFeed({ id: "haodan", alias: "haodan", origin: "feed", categoryId: 30 }, { fetchImpl })).items).toEqual([]);
  });
});
