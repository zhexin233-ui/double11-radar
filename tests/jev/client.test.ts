import { describe, expect, it, vi } from "vitest";
import { callSystemOne, JevError, testJevConnection } from "@/lib/jev/client";
import { jsonResponse } from "../fixtures/xianbao";

const config = {
  baseUrl: "https://jev.test",
  apiKey: "secret-key",
  model: "jev-latest",
  timeoutMs: 5000,
};

const request = {
  state: "{}",
  model: "jev-latest",
  questions: {
    q1: {
      type: "choice" as const,
      criteria: { matched: "a", not_matched: "b", uncertain: "c" },
      instructions: "i",
    },
  },
};

describe("Jev 客户端（mock 验证，未做真实接口验证）", () => {
  it("POST 到 /v1/systemone 并带 Bearer 头", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: "jev-latest", answers: { q1: { type: "choice", choice: "matched" } } }),
    );
    const response = await callSystemOne(config, request, { fetchImpl });
    expect(response.answers?.q1).toBeDefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://jev.test/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-key",
    );
  });

  it("HTTP 非 2xx 抛 JevError", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(callSystemOne(config, request, { fetchImpl })).rejects.toBeInstanceOf(
      JevError,
    );
  });

  it("响应不是合法 JSON 抛 JevError", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(callSystemOne(config, request, { fetchImpl })).rejects.toMatchObject({
      name: "JevError",
      retryable: false,
    });
  });

  it("超时抛 JevError 且可重试", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(callSystemOne(config, request, { fetchImpl })).rejects.toMatchObject({
      name: "JevError",
      retryable: true,
    });
  });

  it("连接测试返回清洗后的结果，不泄露密钥", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answers: { connectivity: { type: "choice", choice: "matched" } } }));
    const result = await testJevConnection(config, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("连接测试失败时返回错误信息而不是抛出", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const result = await testJevConnection(config, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
  });
});

describe("网络失败信息必须中文化且可操作（不泄露英文原始信息）", () => {
  it("超时给出中文可操作提示", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    await expect(
      callSystemOne({ ...config, timeoutMs: 1234 }, request, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "JevError",
      message: expect.stringContaining("超时（1234 毫秒）"),
    });
  });

  it("普通网络失败不再回传 fetch failed 之类的英文", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    let message = "（未抛出错误）";
    try {
      await callSystemOne(config, request, { fetchImpl });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }
    expect(message).toContain("无法连接 Jev 服务");
    expect(message).not.toContain("fetch failed");
    expect(/[\u4e00-\u9fff]/.test(message)).toBe(true);
  });
});
