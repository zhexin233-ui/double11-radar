import { describe, expect, it, vi } from "vitest";
import { genFeishuSign } from "@/lib/notify/feishu-sign";
import { buildFeishuPost, buildFeishuStage2Card, sendFeishu } from "@/lib/notify/feishu";
import type { ChannelMessage, NotifyMessage } from "@/lib/notify/types";
import { LEGACY_STAGE2_ANSWER, STAGE2_RATINGS } from "../fixtures/stage2";
import { jsonResponse } from "../fixtures/xianbao";

const MESSAGE: NotifyMessage = {
  bulletinTitle: "心相印超韧抽纸 24包",
  needs: ["抽纸", "厨房纸"],
  explanation: "该线报被 Jev 判为符合需求：抽纸、厨房纸",
  url: "https://new.xianbao.fun/haodan/1.html",
  price: 9.9,
};

const STAGE2_MESSAGE = {
  ...MESSAGE,
  bulletinTitle: "原线报长标题（仅在详情页展示）",
  needs: ["抽纸"],
  mall: "示例商城",
  channelName: "示例频道",
  analysis: { ...LEGACY_STAGE2_ANSWER, ratings: STAGE2_RATINGS },
};

const WEBHOOK = "https://open.feishu.cn/hook";

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

  it.each([19021, 19022, 19024])("卡片收到配置错误 %i 时记录业务码并停止重试", async (code) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code, msg: "configuration error" }),
    );
    const result = await sendFeishu(
      STAGE2_MESSAGE,
      { webhookUrl: WEBHOOK },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.bizCode).toBe(String(code));
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

  it.each([
    ["一级命中", MESSAGE],
    ["二级降级", { ...MESSAGE, analysisFallbackNote: "二级核验失败，按一级原文推送" }],
    ["系统告警", { kind: "system_alert", title: "密钥异常", lines: ["请检查密钥"] }],
  ] satisfies Array<[string, ChannelMessage]>)("%s仍使用对象形式的 post 富文本（AC3）", async (_scenario, message) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }));
    await sendFeishu(message, { webhookUrl: WEBHOOK }, { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      msg_type: "post",
      content: { post: buildFeishuPost(message) },
    });
  });
});

describe("飞书二级核验交互卡片（AC2、AC3，模拟 Webhook）", () => {
  it("发送带签名、关键词、宽屏配置、两行双列评分和原链接按钮的卡片", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }));
    const result = await sendFeishu(STAGE2_MESSAGE, {
      webhookUrl: WEBHOOK,
      keywordPrefix: "线报提醒：",
      signingSecret: "s3cret",
    }, { fetchImpl });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.timestamp).toMatch(/^\d+$/);
    expect(body.sign).toBe(genFeishuSign("s3cret", Number(body.timestamp)));
    expect(body.msg_type).toBe("interactive");
    expect(body).not.toHaveProperty("content");
    expect(body.card).toEqual({
      config: { wide_screen_mode: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "线报提醒：[推荐] ★★★★☆ 维达抽纸 24 包" },
      },
      elements: [
        { tag: "div", text: { tag: "plain_text", content: "到手 29.9 元 · 1.25 元/包 | 命中：抽纸" } },
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: "**价格力度**\n★★★★★" } },
            { is_short: true, text: { tag: "lark_md", content: "**需求契合**\n★★☆☆☆" } },
          ],
        },
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: "**下单省心**\n★★★☆☆" } },
            { is_short: true, text: { tag: "lark_md", content: "**低风险度**\n暂无数据" } },
          ],
        },
        { tag: "div", text: { tag: "plain_text", content: "近期好价可入\n注意：需先领券" } },
        {
          tag: "action",
          actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "查看原始线报" }, url: MESSAGE.url }],
        },
      ],
    });
  });

  it.each([
    ["recommended", "green", "推荐"],
    ["acceptable", "blue", "可考虑"],
    ["insufficient_info", "orange", "待核对"],
    ["rejected", "red", "不推荐"],
  ] as const)("%s 使用对应的状态颜色和标签", (verdict, color, label) => {
    const card = buildFeishuStage2Card({
      ...STAGE2_MESSAGE,
      analysis: { ...STAGE2_MESSAGE.analysis, verdict, ratings: { ...STAGE2_RATINGS, overall: null } },
    });
    expect(card.header.template).toBe(color);
    expect(card.header.title.content).toBe(`[${label}] 维达抽纸 24 包`);
  });

  it.each([
    ["字段缺省", LEGACY_STAGE2_ANSWER],
    ["字段为 null", { ...LEGACY_STAGE2_ANSWER, ratings: null }],
  ] as const)("历史评分%s时仍发送卡片，省略星级和缺失内容", async (_scenario, answer) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }));
    const result = await sendFeishu({
      ...STAGE2_MESSAGE,
      url: "",
      analysis: { ...answer, actualTotalPrice: null, unitPrice: null, risks: [] },
    }, { webhookUrl: WEBHOOK }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      msg_type: "interactive",
      card: {
        config: { wide_screen_mode: true },
        header: { template: "green", title: { tag: "plain_text", content: "[推荐] 维达抽纸 24 包" } },
        elements: [
          { tag: "div", text: { tag: "plain_text", content: "命中：抽纸" } },
          { tag: "div", text: { tag: "plain_text", content: "近期好价可入" } },
        ],
      },
    });
  });

  it.each([
    "/haodan/1.html",
    "//example.test/haodan/1.html",
    "javascript:void(0)",
    "ftp://example.test/haodan/1.html",
    "https://",
    "https:///haodan/1.html",
    "https://example.test:bad/haodan/1.html",
    "https://example.test/原线报 标题",
  ])("原链接 %s 无效时仍发送卡片并仅省略按钮", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 0 }));
    const result = await sendFeishu({ ...STAGE2_MESSAGE, url }, { webhookUrl: WEBHOOK }, { fetchImpl });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.msg_type).toBe("interactive");
    expect(body.card.elements).toEqual(buildFeishuStage2Card({ ...STAGE2_MESSAGE, url: "" }).elements);
    expect(body.card.elements).not.toContainEqual(expect.objectContaining({ tag: "action" }));
  });

  it("接受带查询参数和片段的绝对 HTTP 地址", () => {
    const url = "http://example.test/haodan/1.html?from=feed#details";
    const card = buildFeishuStage2Card({ ...STAGE2_MESSAGE, url });

    expect(card.elements.at(-1)).toMatchObject({ tag: "action", actions: [{ url }] });
  });

  it("将外部文本放在纯文本节点，并归一化换行和截断结论风险", () => {
    const card = buildFeishuStage2Card({
      ...STAGE2_MESSAGE,
      needs: ["*抽纸*\n第二行"],
      analysis: {
        ...STAGE2_MESSAGE.analysis,
        summary: `<at id=all></at>\n${"🛒".repeat(99)}`,
        risks: [`首条\r\n${"限".repeat(99)}`],
      },
    });
    expect(card.elements[0]).toEqual({
      tag: "div", text: { tag: "plain_text", content: "到手 29.9 元 · 1.25 元/包 | 命中：*抽纸* 第二行" },
    });
    const summary = `<at id=all></at> ${"🛒".repeat(62)}…`;
    expect(card.elements[3]).toEqual({
      tag: "div", text: { tag: "plain_text", content: `${summary}\n注意：首条 ${"限".repeat(56)}…` },
    });
  });
});

describe("飞书网络失败信息中文化且不泄露 Webhook", () => {
  it("网络失败给出中文提示，且消息中不含 Webhook 地址", async () => {
    const webhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/super-secret-webhook";
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await sendFeishu(
      MESSAGE,
      { webhookUrl },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("飞书机器人无法连接");
    expect(result.error).not.toContain("fetch failed");
    // Webhook 本身是凭据，绝不能出现在错误信息里
    expect(result.error).not.toContain(webhookUrl);
    expect(result.error).not.toContain("super-secret-webhook");
  });
});
