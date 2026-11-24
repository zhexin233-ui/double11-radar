import type { Stage2ToolRecord } from "@/lib/domain/types";
import type { RegisteredTool, ToolExecutionOutcome } from "@/lib/agent/tools/types";

const MICRO_SCALE = 1_000_000;

function toMicros(value: number): number {
  return Math.round(value * MICRO_SCALE);
}

function fromMicros(micros: number): number {
  return Number((micros / MICRO_SCALE).toFixed(4));
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function badArgs(message: string): ToolExecutionOutcome {
  return {
    ok: false,
    infrastructureFailure: false,
    content: JSON.stringify({ error: message }),
    error: message,
  };
}

function handleUnitPrice(args: Record<string, unknown>): ToolExecutionOutcome {
  const totalPrice = args.totalPrice;
  const packCount = args.packCount ?? 1;
  const sizePerPack = args.sizePerPack;
  const rawUnit = typeof args.unit === "string" ? args.unit.trim() : "";

  if (!isPositiveFinite(totalPrice)) {
    return badArgs("totalPrice 必须是大于 0 的有限数字");
  }
  if (!isPositiveFinite(packCount)) {
    return badArgs("packCount 必须是大于 0 的有限数字");
  }
  if (!isPositiveFinite(sizePerPack)) {
    return badArgs("sizePerPack 必须是大于 0 的有限数字");
  }
  if (!rawUnit) {
    return badArgs("unit 不能为空（支持 g/kg/ml/L/抽/片/包/件/粒/支）");
  }

  const totalMicros = toMicros(totalPrice);
  const perPackYuan = totalMicros / MICRO_SCALE / packCount;
  const totalQuantity = packCount * sizePerPack;
  const unitLower = rawUnit.toLowerCase();

  let standardUnitLabel = `元/${rawUnit}`;
  let standardUnitPrice = totalMicros / MICRO_SCALE / totalQuantity;
  let conversionNote = "";

  if (unitLower === "g") {
    const totalGrams = totalQuantity;
    standardUnitPrice = ((totalMicros / MICRO_SCALE) * 500) / totalGrams;
    standardUnitLabel = "元/500g";
    conversionNote = `总净重 ${totalGrams}g，折算 500g`;
  } else if (unitLower === "kg") {
    const totalGrams = totalQuantity * 1000;
    standardUnitPrice = ((totalMicros / MICRO_SCALE) * 500) / totalGrams;
    standardUnitLabel = "元/500g";
    conversionNote = `总净重 ${totalQuantity}kg（${totalGrams}g），折算 500g`;
  } else if (unitLower === "ml") {
    const totalMl = totalQuantity;
    standardUnitPrice = ((totalMicros / MICRO_SCALE) * 1000) / totalMl;
    standardUnitLabel = "元/L";
    conversionNote = `总容量 ${totalMl}ml，折算 1L`;
  } else if (unitLower === "l") {
    standardUnitPrice = totalMicros / MICRO_SCALE / totalQuantity;
    standardUnitLabel = "元/L";
    conversionNote = `总容量 ${totalQuantity}L`;
  } else if (rawUnit === "抽") {
    standardUnitPrice = ((totalMicros / MICRO_SCALE) * 100) / totalQuantity;
    standardUnitLabel = "元/100抽";
    conversionNote = `总计 ${totalQuantity}抽，折算 100抽`;
  } else {
    conversionNote = `总计 ${totalQuantity}${rawUnit}`;
  }

  const perPackRounded = fromMicros(toMicros(perPackYuan));
  const stdRounded = fromMicros(toMicros(standardUnitPrice));
  const formula = `${roundMoney(totalPrice)} 元 ÷ (${packCount} × ${sizePerPack}${rawUnit}) → 每包/件 ${perPackRounded} 元，${stdRounded} ${standardUnitLabel}（${conversionNote}）`;

  return {
    ok: true,
    infrastructureFailure: false,
    content: JSON.stringify({
      totalPrice: roundMoney(totalPrice),
      packCount,
      sizePerPack,
      unit: rawUnit,
      perPackPrice: perPackRounded,
      standardUnitPrice: stdRounded,
      standardUnitLabel,
      formula,
    }),
  };
}

interface CouponRule {
  minSpend?: number;
  discount: number;
}

function handlePromoNetPrice(
  args: Record<string, unknown>,
): ToolExecutionOutcome {
  const itemOriginalPrice = args.itemOriginalPrice;
  const itemQuantity = args.itemQuantity ?? 1;
  const extraFillerAmount = args.extraFillerAmount ?? 0;
  const memberDiscount = args.memberDiscount ?? 1;

  if (!isPositiveFinite(itemOriginalPrice)) {
    return badArgs("itemOriginalPrice 必须是大于 0 的有限数字");
  }
  if (!isPositiveFinite(itemQuantity)) {
    return badArgs("itemQuantity 必须是大于 0 的有限数字");
  }
  if (!isNonNegativeFinite(extraFillerAmount)) {
    return badArgs("extraFillerAmount 必须是大于等于 0 的有限数字");
  }
  if (
    typeof memberDiscount !== "number" ||
    !Number.isFinite(memberDiscount) ||
    memberDiscount <= 0 ||
    memberDiscount > 1
  ) {
    return badArgs("memberDiscount 必须在 (0, 1] 区间内");
  }

  const itemSubtotalMicros = Math.round(
    toMicros(itemOriginalPrice) * itemQuantity,
  );
  const fillerMicros = toMicros(extraFillerAmount);
  const steps: string[] = [
    `目标商品原价小计: ${roundMoney(itemOriginalPrice)} × ${itemQuantity} = ${fromMicros(itemSubtotalMicros)} 元`,
  ];

  // 1. 跨店满减（按货值比例分摊到目标商品）
  let itemAfterCrossStoreMicros = itemSubtotalMicros;
  const crossStoreRule = args.crossStoreRule as
    | { everySpend?: unknown; discount?: unknown }
    | undefined;
  if (crossStoreRule && typeof crossStoreRule === "object") {
    const everySpend = crossStoreRule.everySpend;
    const discount = crossStoreRule.discount;
    if (!isPositiveFinite(everySpend) || !isNonNegativeFinite(discount)) {
      return badArgs("crossStoreRule.everySpend 必须 > 0 且 discount >= 0");
    }
    const orderSubtotalMicros = itemSubtotalMicros + fillerMicros;
    const everyMicros = toMicros(everySpend);
    const times = Math.floor(orderSubtotalMicros / everyMicros);
    const totalCrossDiscountMicros = Math.min(
      orderSubtotalMicros,
      times * toMicros(discount),
    );
    const allocatedCrossDiscountMicros =
      orderSubtotalMicros > 0
        ? Math.round(
            (totalCrossDiscountMicros * itemSubtotalMicros) /
              orderSubtotalMicros,
          )
        : 0;
    itemAfterCrossStoreMicros = Math.max(
      0,
      itemSubtotalMicros - allocatedCrossDiscountMicros,
    );
    steps.push(
      `跨店满减(每满${everySpend}减${discount}, 凑单${extraFillerAmount}元): 订单总满减 ${fromMicros(totalCrossDiscountMicros)} 元，目标商品按货值比例分摊减免 ${fromMicros(allocatedCrossDiscountMicros)} 元 → ${fromMicros(itemAfterCrossStoreMicros)} 元`,
    );
  }

  // 2. 优惠券（按顺序扣减满足门槛的券）
  let itemAfterCouponMicros = itemAfterCrossStoreMicros;
  if (Array.isArray(args.coupons)) {
    for (const rawCoupon of args.coupons) {
      if (!rawCoupon || typeof rawCoupon !== "object") {
        return badArgs("coupons 元素必须是对象");
      }
      const c = rawCoupon as CouponRule;
      if (!isNonNegativeFinite(c.discount)) {
        return badArgs("coupon.discount 必须是大于等于 0 的数字");
      }
      const minSpend = c.minSpend ?? 0;
      if (!isNonNegativeFinite(minSpend)) {
        return badArgs("coupon.minSpend 必须是大于等于 0 的数字");
      }
      if (itemAfterCouponMicros >= toMicros(minSpend)) {
        const discountMicros = toMicros(c.discount);
        itemAfterCouponMicros = Math.max(0, itemAfterCouponMicros - discountMicros);
        steps.push(
          `适用优惠券(满${minSpend}减${c.discount}): 抵扣后 ${fromMicros(itemAfterCouponMicros)} 元`,
        );
      } else {
        steps.push(
          `跳过未达门槛优惠券(满${minSpend}减${c.discount}): 当前仅 ${fromMicros(itemAfterCouponMicros)} 元`,
        );
      }
    }
  }

  // 3. 会员折扣
  const finalMicros = Math.round(itemAfterCouponMicros * memberDiscount);
  if (memberDiscount < 1) {
    steps.push(
      `会员折扣(${memberDiscount}): 折后 ${fromMicros(finalMicros)} 元`,
    );
  }

  const netTotal = roundMoney(finalMicros / MICRO_SCALE);
  const netPerItem = roundMoney(netTotal / itemQuantity);
  const effectiveDiscountRate =
    itemSubtotalMicros > 0
      ? Number((finalMicros / itemSubtotalMicros).toFixed(4))
      : 1;

  return {
    ok: true,
    infrastructureFailure: false,
    content: JSON.stringify({
      netTotal,
      netPerItem,
      effectiveDiscountRate,
      steps,
    }),
  };
}

function handleBudgetCheck(
  args: Record<string, unknown>,
): ToolExecutionOutcome {
  const actualValue = args.actualValue;
  const limitValue = args.limitValue;
  const unitLabel =
    typeof args.unitLabel === "string" && args.unitLabel.trim()
      ? args.unitLabel.trim()
      : "元";

  if (!isNonNegativeFinite(actualValue) || !isPositiveFinite(limitValue)) {
    return badArgs("actualValue 须 >= 0 且 limitValue 须 > 0");
  }

  const actualMicros = toMicros(actualValue);
  const limitMicros = toMicros(limitValue);
  const diffMicros = actualMicros - limitMicros;
  const withinBudget = actualMicros <= limitMicros;
  const diff = fromMicros(diffMicros);
  const diffPercent = Number(
    (((actualMicros - limitMicros) / limitMicros) * 100).toFixed(2),
  );

  return {
    ok: true,
    infrastructureFailure: false,
    content: JSON.stringify({
      withinBudget,
      actualValue: fromMicros(actualMicros),
      limitValue: fromMicros(limitMicros),
      unitLabel,
      diff,
      diffPercent,
      formula: `${fromMicros(actualMicros)} ${unitLabel} ${withinBudget ? "<=" : ">"} 预算上限 ${fromMicros(limitMicros)} ${unitLabel}（差额 ${diff >= 0 ? "+" : ""}${diff} ${unitLabel}，${diffPercent >= 0 ? "+" : ""}${diffPercent}%）`,
    }),
  };
}

export function createCalculatorTool(plugin: Stage2ToolRecord): RegisteredTool {
  const functionName = "calculate_price";
  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    functionName,
    definition: {
      type: "function",
      function: {
        name: functionName,
        description:
          "确定性高精度价格计算器。支持 3 种模式：unit_price（单位换算单价如元/500g、元/L、元/100抽）、promo_net_price（满减/优惠券/跨店凑单按货值分摊/会员折扣）、budget_check（预算上限核对）。严禁自己心算，必须调用此工具计算。",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["unit_price", "promo_net_price", "budget_check"],
              description: "计算模式",
            },
            totalPrice: { type: "number", description: "unit_price: 到手总价(元)" },
            packCount: { type: "number", description: "unit_price: 包/件/瓶数量，默认1" },
            sizePerPack: { type: "number", description: "unit_price: 每包/件规格数值" },
            unit: {
              type: "string",
              description: "unit_price: 单位(g/kg/ml/L/抽/片/包/件/粒/支)",
            },
            itemOriginalPrice: {
              type: "number",
              description: "promo_net_price: 目标商品单价(元)",
            },
            itemQuantity: {
              type: "number",
              description: "promo_net_price: 目标商品件数，默认1",
            },
            extraFillerAmount: {
              type: "number",
              description: "promo_net_price: 凑单品金额(元)，默认0",
            },
            crossStoreRule: {
              type: "object",
              properties: {
                everySpend: { type: "number" },
                discount: { type: "number" },
              },
              description: "promo_net_price: 跨店满减规则(如每满300减50)",
            },
            coupons: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  minSpend: { type: "number" },
                  discount: { type: "number" },
                },
                required: ["discount"],
              },
              description: "promo_net_price: 店铺券/品类券列表",
            },
            memberDiscount: {
              type: "number",
              description: "promo_net_price: 会员折上折系数(如0.95)，默认1",
            },
            actualValue: { type: "number", description: "budget_check: 实际价格/单价" },
            limitValue: { type: "number", description: "budget_check: 预算上限" },
            unitLabel: { type: "string", description: "budget_check: 单位标签，如元/500g" },
          },
          required: ["mode"],
        },
      },
    },
    execute: async (args) => {
      switch (args.mode) {
        case "unit_price":
          return handleUnitPrice(args);
        case "promo_net_price":
          return handlePromoNetPrice(args);
        case "budget_check":
          return handleBudgetCheck(args);
        default:
          return badArgs(
            "mode 必须是 unit_price、promo_net_price 或 budget_check",
          );
      }
    },
  };
}
