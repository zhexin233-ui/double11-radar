import { describe, expect, it } from "vitest";
import { createCalculatorTool } from "@/lib/agent/tools/builtin-calculator";
import type { Stage2ToolRecord } from "@/lib/domain/types";

const MOCK_PLUGIN: Stage2ToolRecord = {
  id: "builtin-calculator",
  name: "确定性价格计算器",
  kind: "builtin",
  builtinKey: "calculator",
  enabled: true,
  sortOrder: 10,
  config: {},
  secretNamespace: null,
  cachedSchema: null,
  healthStatus: "healthy",
  consecutiveFailures: 0,
  failureThreshold: 3,
  cooldownMinutes: 15,
  cooldownUntil: null,
  lastError: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
};

describe("agent/builtin-calculator (AC3)", () => {
  const calc = createCalculatorTool(MOCK_PLUGIN);

  it("unit_price 正确归一化 g/kg/ml/抽 并消除浮点漂移", async () => {
    const res1 = await calc.execute({
      mode: "unit_price",
      totalPrice: 29.9,
      packCount: 24,
      sizePerPack: 100,
      unit: "抽",
    });
    expect(res1.ok).toBe(true);
    const data1 = JSON.parse(res1.content);
    expect(data1.standardUnitLabel).toBe("元/100抽");
    expect(data1.standardUnitPrice).toBeCloseTo(1.2458, 4);
    expect(data1.perPackPrice).toBeCloseTo(1.2458, 4);

    const res2 = await calc.execute({
      mode: "unit_price",
      totalPrice: 30,
      packCount: 2,
      sizePerPack: 1.5,
      unit: "kg",
    });
    expect(res2.ok).toBe(true);
    const data2 = JSON.parse(res2.content);
    expect(data2.standardUnitLabel).toBe("元/500g");
    expect(data2.standardUnitPrice).toBe(5);
  });

  it("promo_net_price 精确计算跨店满减凑单按货值比例分摊、券与会员折扣", async () => {
    // 目标商品 200 元，凑单品 100 元，每满 300 减 50 → 比例 2/3，分摊减 33.333333 元 → 166.67 元
    // 再用满 100 减 10 券 → 156.67 元，95 折会员 → 148.83 元
    const res = await calc.execute({
      mode: "promo_net_price",
      itemOriginalPrice: 200,
      itemQuantity: 1,
      extraFillerAmount: 100,
      crossStoreRule: { everySpend: 300, discount: 50 },
      coupons: [{ minSpend: 100, discount: 10 }],
      memberDiscount: 0.95,
    });
    expect(res.ok).toBe(true);
    const data = JSON.parse(res.content);
    expect(data.netTotal).toBe(148.83);
    expect(data.netPerItem).toBe(148.83);
    expect(Array.isArray(data.steps)).toBe(true);
    expect(data.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("budget_check 准确对比预算上限", async () => {
    const res = await calc.execute({
      mode: "budget_check",
      actualValue: 18.5,
      limitValue: 20,
      unitLabel: "元/500g",
    });
    expect(res.ok).toBe(true);
    const data = JSON.parse(res.content);
    expect(data.withinBudget).toBe(true);
    expect(data.diff).toBe(-1.5);
  });

  it("异常输入返回结构化业务错误且不触发基础设施失败", async () => {
    const res = await calc.execute({
      mode: "unit_price",
      totalPrice: -10,
      packCount: 0,
      sizePerPack: 100,
      unit: "g",
    });
    expect(res.ok).toBe(false);
    expect(res.infrastructureFailure).toBe(false);
    expect(res.content).not.toContain("NaN");
  });
});
