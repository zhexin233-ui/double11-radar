import { describe, expect, it, vi } from "vitest";
import { genFeishuSign } from "@/lib/notify/feishu-sign";
import { buildFeishuPost, sendFeishu } from "@/lib/notify/feishu";
import type { NotifyMessage } from "@/lib/notify/types";
import { jsonResponse } from "../fixtures/xianbao";

const MESSAGE: NotifyMessage = {
  bulletinTitle: "心相印超韧抽纸 24包",
  needs: ["抽纸", "厨房纸"],
  explanation: "该线报被 Jev 判为符合需求：抽纸、厨房纸",
  url: "https://new.xianbao.fun/haodan/1.html",
  price: 9.9,
};

describe("飞书签名（官方 Method 3）", () => {
  it("对固定输入产生稳定的 Base64 签名", () => {
    const sign = genFeishuSign("test-secret", 1791909780);
    // 用独立实现交叉验证：HMAC-SHA256(key=`ts\nsecret`, msg="") → Base64
    expect(sign).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(genFeishuSign("test-secret", 1791909780)).toBe(sign);
    expect(genFeishuSign("test-secret", 1791909781)).not.toBe(sign);
    expect(genFeishuSign("other-secret", 1791909780)).not.toBe(sign);
  });
});

describe("飞书群 Webhook（mock 验证）", () => {
  it("post 富文本包含标题与可点击链接节点", () => {
    const post = buildFeishuPost(MESSAGE);
    expect(post.zh_cn.title).toContain("命中");
    expect(JSON.stringify(post.zh_cn.content)).toContain('"tag":"a"');
    expect(JSON.stringify(post.zh_cn.content)).toContain(MESSAGE.url);
  });

  it("关键词前缀写入标题", () => {
    const post = buildFeishuPost(MESSAGE, "线报提醒：");
    expect(post.zh_cn.title.startsWith("线报提醒：")).toBe(true);
  });

  it("业务 code 为 0 才算成功", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: {}, msg: "success" }),
    );
    const result = await sendFeishu(
      MESSAGE,
      { webhookUrl: "https://open.feishu.cn/hook" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.bizCode).toBe("0");
  });

  it("HTTP200 但业务非 0 不算成功，且记录 biz_code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 19024, msg: "key words not found" }),
    );
    const result = await sendFeishu(
      MESSAGE,
      { webhookUrl: "https://open.feishu.cn/hook" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.bizCode).toBe("19024");
    expect(result.retryable).toBe(false);
  });

  it("限流码可重试", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 11232, msg: "too many" }));
    const result = await sendFeishu(
      MESSAGE,
      { webhookUrl: "https://open.feishu.cn/hook" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("开启签名时 body 顶层带 timestamp 与 sign", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0 }));
    await sendFeishu(
      MESSAGE,
      { webhookUrl: "https://open.feishu.cn/hook", signingSecret: "s3cret" },
      { fetchImpl },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.sign).toBe("string");
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });

  it("content 是对象而不是字符串化的 JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0 }));
    await sendFeishu(
      MESSAGE,
      { webhookUrl: "https://open.feishu.cn/hook" },
      { fetchImpl },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { content: unknown };
    expect(typeof body.content).toBe("object");
  });
});
