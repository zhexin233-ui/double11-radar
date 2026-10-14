import { describe, expect, it } from "vitest";
import {
  computePollIntervalSeconds,
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
});
