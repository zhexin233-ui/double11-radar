import { describe, expect, it } from "vitest";
import {
  estimateCost,
  formatUsdFromNanos,
  parseTokenCount,
  OFFICIAL_JE_PROVIDER_HOST,
  PRICE_VERSIONS,
} from "@/lib/jev/pricing";
import { parseRetryAfterMs } from "@/lib/jev/client";

/**
 * Jev 费用估算与 Token 计数的纯函数契约（AC5/AC6）。
 *
 * 这些函数没有 I/O，本文件不 mock 任何传输层，断言的是计费边界本身：
 * 「未知」永远不能伪装成 $0，极小正数不能被舍入成 $0.00。
 */

const OFFICIAL_PROVIDER = `https://${OFFICIAL_JE_PROVIDER_HOST}`;
const JEV_1_13 = "jev-1.13.0";
const MTOK = 1_000_000;

function officialInput(
  overrides: Partial<Parameters<typeof estimateCost>[0]> = {},
): Parameters<typeof estimateCost>[0] {
  return {
    inputTokens: MTOK,
    outputTokens: null,
    responseModel: JEV_1_13,
    providerOrigin: OFFICIAL_PROVIDER,
    ...overrides,
  };
}

describe("parseTokenCount：未知与已知 0 必须严格区分（AC5）", () => {
  it("null/undefined/字符串/负数/小数/NaN/Infinity/超安全整数一律为 null", () => {
    expect(parseTokenCount(null)).toBeNull();
    expect(parseTokenCount(undefined)).toBeNull();
    expect(parseTokenCount("1000")).toBeNull();
    expect(parseTokenCount(-1)).toBeNull();
    expect(parseTokenCount(1.5)).toBeNull();
    expect(parseTokenCount(Number.NaN)).toBeNull();
    expect(parseTokenCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseTokenCount(Number.NEGATIVE_INFINITY)).toBeNull();
    // 2^53 超过 Number.MAX_SAFE_INTEGER，无法精确计价。
    expect(parseTokenCount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it("0 是已知的 0（不是未知），非负安全整数原样返回", () => {
    expect(parseTokenCount(0)).toBe(0);
    expect(parseTokenCount(1)).toBe(1);
    expect(parseTokenCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("estimateCost：公布费率下的美元估算（AC5/AC6）", () => {
  it("1,000,000 输入 + jev-1.13.0 + 官方 provider = 42,000,000 纳美元（$0.042）", () => {
    const estimate = estimateCost(officialInput());
    expect(estimate.costStatus).toBe("known");
    expect(estimate.estimatedUsdNanos).toBe(42_000_000);
    expect(estimate.priceVersion).toBe(PRICE_VERSIONS[0].version);
    expect(estimate.inputRateNanosPerToken).toBe(42);
    expect(estimate.unknownReason).toBeNull();
  });

  it("输出 Token 免费：不增加费用", () => {
    const withOutput = estimateCost(officialInput({ outputTokens: 5_000_000 }));
    expect(withOutput.costStatus).toBe("known");
    expect(withOutput.estimatedUsdNanos).toBe(42_000_000);
  });

  it("输入用量缺失或 null 时费用未知，绝不显示为 $0", () => {
    for (const inputTokens of [null, undefined as unknown as null]) {
      const estimate = estimateCost(officialInput({ inputTokens }));
      expect(estimate.costStatus).toBe("unknown");
      expect(estimate.estimatedUsdNanos).toBeNull();
      expect(estimate.unknownReason).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("未知模型名时费用未知", () => {
    const estimate = estimateCost(officialInput({ responseModel: "jev-9.9.9" }));
    expect(estimate.costStatus).toBe("unknown");
    expect(estimate.estimatedUsdNanos).toBeNull();
  });

  it("响应未报告模型版本时费用未知（别名不能套用未核实的费率）", () => {
    const estimate = estimateCost(officialInput({ responseModel: null }));
    expect(estimate.costStatus).toBe("unknown");
    expect(estimate.estimatedUsdNanos).toBeNull();
  });

  it("非官方 provider 时不套用公布费率", () => {
    const estimate = estimateCost(
      officialInput({ providerOrigin: "https://example.com" }),
    );
    expect(estimate.costStatus).toBe("unknown");
    expect(estimate.estimatedUsdNanos).toBeNull();
  });

  it("输入为 0 是已知的 0 费用", () => {
    const estimate = estimateCost(officialInput({ inputTokens: 0 }));
    expect(estimate.costStatus).toBe("known");
    expect(estimate.estimatedUsdNanos).toBe(0);
  });
});

describe("formatUsdFromNanos：极小正数不能显示成 $0.00（AC5）", () => {
  it("42,000,000 纳美元显示为 0.042", () => {
    expect(formatUsdFromNanos(42_000_000)).toBe("0.042");
  });

  it("42 纳美元必须显示为非零小数", () => {
    const formatted = formatUsdFromNanos(42);
    expect(formatted).not.toBe("0.00");
    expect(Number(formatted)).toBeGreaterThan(0);
  });

  it("0 显示为 0.00", () => {
    expect(formatUsdFromNanos(0)).toBe("0.00");
  });
});

describe("parseRetryAfterMs：官方 Retry-After 语义（AC6）", () => {
  it("秒数形式解析为毫秒", () => {
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("HTTP 日期形式按注入时钟解析", () => {
    const now = new Date("2026-10-14T00:00:00.000Z");
    const header = new Date(now.getTime() + 5_000).toUTCString();
    expect(parseRetryAfterMs(header, now)).toBe(5000);
  });

  it("非法值返回 null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });

  it("已经过去的 HTTP 日期按 0 处理（无需等待）", () => {
    const now = new Date("2026-10-14T00:00:10.000Z");
    const past = new Date(now.getTime() - 5_000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });
});
