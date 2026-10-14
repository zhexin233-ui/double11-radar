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
        { id: "haodan", alias: "haodan", origin: "feed" },
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
        { id: "haodan", alias: "haodan", origin: "feed" },
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
      { id: "haodan", alias: "haodan", origin: "feed" },
      { baseUrl: "https://example.test", fetchImpl },
    );
    await fetchFeed(
      { id: "zdm", alias: "zdm", origin: "zdm" },
      { baseUrl: "https://example.test", fetchImpl },
    );
    expect(calls[0]).toContain("cate=haodan");
    expect(calls[1]).toContain("type=zdm");
  });
});
