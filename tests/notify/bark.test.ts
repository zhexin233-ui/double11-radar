import { describe, expect, it, vi } from "vitest";
import { sendBark } from "@/lib/notify/bark";
import type { NotifyMessage } from "@/lib/notify/types";
import { LEGACY_STAGE2_ANSWER, STAGE2_RATINGS } from "../fixtures/stage2";
import { jsonResponse } from "../fixtures/xianbao";

const MESSAGE: NotifyMessage = {
  bulletinTitle: "心相印超韧抽纸 24包",
  needs: ["抽纸"],
  explanation: "该线报被 Jev 判为符合需求：抽纸",
  url: "https://new.xianbao.fun/haodan/1.html",
  price: 9.9,
};

const CONFIG = { serverUrl: "https://api.day.app", deviceKey: "device-key" };

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
    expect(body.title).toBe("命中需求：抽纸");
    expect(body.body).toBe([
      "需求：抽纸",
      `线报：${MESSAGE.bulletinTitle}`,
      "原文价格：9.9 元（来源标注，不代表券后实付）",
      `分类说明（程序生成）：${MESSAGE.explanation}`,
    ].join("\n"));
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

  it("网络错误容错为可重试失败，且不把原始英文信息回传", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("Bark 服务无法连接");
    expect(result.error).not.toContain("network down");
  });
});

describe("Bark 二级核验（AC3、AC4，模拟推送接口）", () => {
  it("系统告警沿用原有标题、正文和分组", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 200 }));
    await sendBark({ kind: "system_alert", title: "密钥异常", lines: ["密钥已停用", "请检查密钥"] }, CONFIG, { fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      device_key: CONFIG.deviceKey,
      title: "密钥异常",
      body: "密钥已停用\n请检查密钥",
      group: "系统密钥通知",
    });
  });

  it("使用四行呈现带风险的评分摘要，原链接可跳转", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 200 }));
    const result = await sendBark({
      ...MESSAGE,
      mall: "示例商城",
      channelName: "示例频道",
      analysis: { ...LEGACY_STAGE2_ANSWER, ratings: STAGE2_RATINGS },
    }, CONFIG, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      title: "[推荐] ★★★★☆ 维达抽纸 24 包",
      body: [
        "到手 29.9 元 · 1.25 元/包 | 命中：抽纸",
        "价格 ★★★★★ | 契合 ★★☆☆☆ | 省心 ★★★☆☆ | 低风险 暂无数据",
        "近期好价可入",
        "注意：需先领券",
      ].join("\n"),
      url: MESSAGE.url,
    });
  });

  it.each([
    ["字段缺省", LEGACY_STAGE2_ANSWER],
    ["字段为 null", { ...LEGACY_STAGE2_ANSWER, ratings: null }],
  ] as const)("历史评分%s时成功发送紧凑正文且省略星级", async (_scenario, answer) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 200 }));
    const result = await sendBark({
      ...MESSAGE,
      analysis: { ...answer, actualTotalPrice: null, unitPrice: null, risks: [] },
    }, CONFIG, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      title: "[推荐] 维达抽纸 24 包",
      body: "命中：抽纸\n近期好价可入",
    });
  });

  it("仍展示零元到手，历史异常分数显示暂无数据", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ code: 200 }));
    await sendBark({
      ...MESSAGE,
      analysis: {
        ...LEGACY_STAGE2_ANSWER,
        actualTotalPrice: 0,
        unitPrice: null,
        ratings: { ...STAGE2_RATINGS, overall: -1, priceValue: 6, needMatch: 2.5 },
        risks: [],
      },
    }, CONFIG, { fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      title: "[推荐] 维达抽纸 24 包",
      body: [
        "到手 0 元 | 命中：抽纸",
        "价格 暂无数据 | 契合 暂无数据 | 省心 ★★★☆☆ | 低风险 暂无数据",
        "近期好价可入",
      ].join("\n"),
    });
  });
});

describe("Bark 网络失败信息中文化（不泄露英文原始信息）", () => {
  it("网络失败给出中文可操作提示且带上服务地址", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Bark 服务无法连接");
    expect(result.error).toContain("https://api.day.app");
    expect(result.error).not.toContain("fetch failed");
    expect(/[\u4e00-\u9fff]/.test(result.error ?? "")).toBe(true);
  });

  it("超时给出中文可操作提示", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    const result = await sendBark(
      MESSAGE,
      { serverUrl: "https://api.day.app", deviceKey: "device-key" },
      { fetchImpl },
    );
    expect(result.error).toContain("Bark 服务调用超时");
    expect(result.error).not.toContain("aborted");
  });
});
