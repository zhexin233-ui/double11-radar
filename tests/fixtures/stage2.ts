import type { Stage2Ratings, StandardizedAnswer } from "@/lib/domain/types";

export const STAGE2_RATINGS: Stage2Ratings = {
  overall: 4,
  priceValue: 5,
  needMatch: 2,
  orderEase: 3,
  lowRisk: null,
};

export const LEGACY_STAGE2_ANSWER = {
  verdict: "recommended",
  summary: "近期好价可入",
  productName: "维达抽纸 24 包",
  actualTotalPrice: 29.9,
  unitPrice: 1.25,
  unitLabel: "元/包",
  priceFormula: "29.9 / 24 = 1.25",
  orderSteps: ["先领商品券，再在购物车提交订单"],
  priceComparison: {
    status: "cheaper",
    referencePrice: 39.9,
    source: "历史比价工具",
    conclusion: "当前价格低于历史均价，具体比价以核验记录为准",
  },
  requirementChecks: [{ needName: "抽纸", satisfied: true, reason: "符合单包预算" }],
  risks: ["需先领券"],
} satisfies StandardizedAnswer;
