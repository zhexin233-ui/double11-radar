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

  it("归一化 usage：缺失/非法为 null，合法为非负整数（AC5）", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q1: { type: "choice", choice: "matched" } },
        usage: { input_tokens: 1000, output_tokens: null },
      }),
    );
    const response = await callSystemOne(config, request, { fetchImpl });
    expect(response.model).toBe("jev-1.13.0");
    expect(response.usage).toEqual({ inputTokens: 1000, outputTokens: null });
  });

  it("缺少 answers 视为结构非法并抛错，不当作没有匹配", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: "jev-latest" }));
    await expect(callSystemOne(config, request, { fetchImpl })).rejects.toMatchObject({
      name: "JevError",
      retryable: false,
    });
  });

  it("失败响应里可核实的 usage 与 request id 会挂在 JevError 上", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 500 } }), {
          status: 429,
          headers: {
            "retry-after": "7",
            "x-typesafe-request-id": "req-429",
          },
        }),
    );
    await expect(callSystemOne(config, request, { fetchImpl })).rejects.toMatchObject({
      name: "JevError",
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
      upstreamRequestId: "req-429",
      usage: { inputTokens: 500, outputTokens: null },
    });
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

  it("连接测试失败时抛出 JevError（由上层统一服务先记账再转中文结果）", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    await expect(testJevConnection(config, { fetchImpl })).rejects.toMatchObject({
      name: "JevError",
      message: expect.stringContaining("401"),
    });
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
      message: expect.stringContaining("Jev 服务调用超时（1234 毫秒）"),
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
    expect(message).toContain("Jev 服务无法连接");
    expect(message).not.toContain("fetch failed");
    expect(/[\u4e00-\u9fff]/.test(message)).toBe(true);
  });
});
