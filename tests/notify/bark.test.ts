import { describe, expect, it, vi } from "vitest";
import { sendBark } from "@/lib/notify/bark";
import type { NotifyMessage } from "@/lib/notify/types";
import { jsonResponse } from "../fixtures/xianbao";

const MESSAGE: NotifyMessage = {
  bulletinTitle: "心相印超韧抽纸 24包",
  needs: ["抽纸"],
  explanation: "该线报被 Jev 判为符合需求：抽纸",
  url: "https://new.xianbao.fun/haodan/1.html",
  price: 9.9,
};

describe("Bark 推送（mock 验证）", () => {
  it("POST 到 /push，带 url 与 group", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 200, message: "success" }));
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.day.app/push");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.url).toBe(MESSAGE.url);
    expect(body.group).toBe("线报需求匹配");
    expect(body.device_key).toBe("device-key");
  });

  it("业务 code 非 200 视为失败", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 400, message: "bad key" }));
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.bizCode).toBe("400");
  });

  it("非 JSON 响应容错为可重试失败", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("网络错误容错为可重试失败", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});
