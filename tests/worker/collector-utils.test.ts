import { describe, expect, it } from "vitest";
import {
  computePollIntervalSeconds,
  computeRateLimitBackoff,
  isRateLimitPaused,
  MIN_REQUEST_SPACING_MS,
  REQUEST_BUDGET_PER_MINUTE,
} from "@/lib/worker/collector";

describe("采集调度预算（AC12）", () => {
  it("频道越多，单频道轮询间隔越大，保持总请求量在预算内", () => {
    const interval = computePollIntervalSeconds(20, 10);
    const requestsPerMinute = (20 * 60) / interval;
    expect(requestsPerMinute).toBeLessThanOrEqual(REQUEST_BUDGET_PER_MINUTE);
  });

  it("不低于接口缓存时间与最小间隔", () => {
    expect(computePollIntervalSeconds(1, 30)).toBeGreaterThanOrEqual(30);
    expect(computePollIntervalSeconds(1, null)).toBeGreaterThanOrEqual(10);
    expect(computePollIntervalSeconds(0, null)).toBeGreaterThanOrEqual(10);
  });

  it("缓存时间为空时使用安全默认值", () => {
    expect(Number.isFinite(computePollIntervalSeconds(5, null))).toBe(true);
  });

  it("轮内对频道请求保留削峰间隔（避免突发触发站点 429）", () => {
    expect(MIN_REQUEST_SPACING_MS).toBeGreaterThan(0);
  });
});

describe("全局限流自适应（AC12）", () => {
  it("剩余额度充足时不暂停", () => {
    expect(
      computeRateLimitBackoff({
        remaining: 51,
        resetAt: "2026-10-13T18:00:00.000Z",
        now: new Date("2026-10-13T17:59:00.000Z"),
      }),
    ).toBeNull();
  });

  it("剩余额度耗尽时暂停到窗口重置时间", () => {
    const until = computeRateLimitBackoff({
      remaining: 0,
      resetAt: "2026-10-13T18:00:00.000Z",
      now: new Date("2026-10-13T17:59:00.000Z"),
    });
    expect(until).toBe("2026-10-13T18:00:00.000Z");
    expect(isRateLimitPaused(until, new Date("2026-10-13T17:59:30.000Z"))).toBe(true);
    expect(isRateLimitPaused(until, new Date("2026-10-13T18:00:01.000Z"))).toBe(false);
  });

  it("缺少重置时间时使用 60 秒保守暂停", () => {
    const now = new Date("2026-10-13T17:59:00.000Z");
    expect(
      computeRateLimitBackoff({ remaining: 1, resetAt: null, now }),
    ).toBe("2026-10-13T18:00:00.000Z");
  });

  it("没有限流头时不暂停", () => {
    expect(
      computeRateLimitBackoff({ remaining: null, resetAt: null, now: new Date() }),
    ).toBeNull();
    expect(isRateLimitPaused(null, new Date())).toBe(false);
  });
});
