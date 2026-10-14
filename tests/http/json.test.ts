import { describe, expect, it } from "vitest";
import { fail, HttpError, ok, requireSameOrigin } from "@/lib/http/json";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://nas.local:3000/api/needs", { headers });
}

describe("API 同源与 CSRF 保护（AC1）", () => {
  it("缺少 x-requested-with 时拒绝写入", () => {
    expect(() =>
      requireSameOrigin(makeRequest({ origin: "http://nas.local:3000" })),
    ).toThrow(HttpError);
  });

  it("带有自定义头且同源时通过", () => {
    expect(() =>
      requireSameOrigin(
        makeRequest({
          "x-requested-with": "fetch",
          origin: "http://nas.local:3000",
          host: "nas.local:3000",
        }),
      ),
    ).not.toThrow();
  });

  it("Origin 与 Host 不一致时拒绝", () => {
    expect(() =>
      requireSameOrigin(
        makeRequest({
          "x-requested-with": "fetch",
          origin: "http://evil.example",
          host: "nas.local:3000",
        }),
      ),
    ).toThrow(/来源/);
  });

  it("没有 Origin 头（同源简单请求）时按自定义头放行", () => {
    expect(() =>
      requireSameOrigin(makeRequest({ "x-requested-with": "fetch" })),
    ).not.toThrow();
  });

  it("统一成功与失败响应结构", async () => {
    const success = await ok({ value: 1 }).json();
    expect(success).toEqual({ ok: true, data: { value: 1 } });
    const failure = await fail("BAD", "参数不合法", 400).json();
    expect(failure).toEqual({ ok: false, error: { code: "BAD", message: "参数不合法" } });
  });
});
