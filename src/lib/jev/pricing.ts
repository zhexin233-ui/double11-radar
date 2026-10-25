import type { JevCostStatus } from "@/lib/domain/types";

/**
 * Jev 费用估算（纯函数，无 I/O）。
 *
 * 设计约束（见任务 design.md 第 6 节）：
 * - 官方 Jev 1.13 / `jev-1.13.0` 按**输入**计费：$0.042 / 百万 Token；输出免费；
 * - 金额以整数**纳美元**保存，避免浮点误差；$1 = 1_000_000_000 纳美元，
 *   故每输入 Token = 42 纳美元，1,000,000 Token = 42,000,000 纳美元 = $0.042；
 * - 价格按**响应报告的模型版本**决定；别名 `jev-latest` 只有在响应确认为
 *   `jev-1.13.0` 时才可按该费率计价；
 * - 未知模型、非官方 provider、缺失/非法输入用量一律标 `unknown`，**绝不显示为 $0**；
 * - 输出用量缺失不影响「仅输入计费」的估算（输出费率为 0）；
 * - 费率是版本化快照，更新只新增版本，绝不重算历史行。
 */

export interface PriceVersion {
  /** 价格版本标识（写入账本，便于追溯）。 */
  version: string;
  /** 覆盖的官方版本化模型 ID（响应 model 必须精确等于其中之一）。 */
  modelIds: readonly string[];
  /** 每输入 Token 的纳美元费率。 */
  inputNanosPerToken: number;
  /** 每输出 Token 的纳美元费率（当前为 0 = 免费）。 */
  outputNanosPerToken: number;
  /** 费率来源（官方文档）。 */
  source: string;
}

/** 官方或官方转售/底价直连服务端主机名；非已知主机（自建/未知 provider）不套用公布费率。 */
export const OFFICIAL_JE_PROVIDER_HOST = "api.typesafe.ai";
export const COMMAND_CODE_PROVIDER_HOST = "api.commandcode.ai";

export const KNOWN_JE_PROVIDER_HOSTS: readonly string[] = [
  OFFICIAL_JE_PROVIDER_HOST,
  COMMAND_CODE_PROVIDER_HOST,
];

export const PRICE_VERSIONS: readonly PriceVersion[] = [
  {
    version: "2026-10-14",
    modelIds: [
      "jev-1.13.0",
      "typesafe/jev-1.13.0",
      "jev-1.14.0",
      "typesafe/jev-1.14.0",
      "typesafe/jev",
    ],
    inputNanosPerToken: 42,
    outputNanosPerToken: 0,
    source: "https://docs.typesafe.ai/models.md / https://commandcode.ai/docs/resources/pricing-limits#models",
  },
];

export type JevRequestCostStatus = JevCostStatus;

export interface CostEstimate {
  costStatus: JevCostStatus;
  /** 未知时给出中文原因，供账本与页面展示。 */
  unknownReason: string | null;
  priceVersion: string | null;
  inputRateNanosPerToken: number | null;
  /** 已知时为整数纳美元；未知为 null。 */
  estimatedUsdNanos: number | null;
}

/**
 * 校验上游报告的 Token 计数：必须是有限、非负的安全整数。
 * 缺失/null/类型非法/负数/非整数/超出安全整数一律返回 null（按该项未知处理）。
 */
export function parseTokenCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0) return null;
  return value;
}

/** 由 baseUrl 推导 provider origin；非法地址返回 null。 */
export function providerOriginFromBaseUrl(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function isSupportedProvider(providerOrigin: string | null): boolean {
  if (!providerOrigin) return false;
  try {
    const hostname = new URL(providerOrigin).hostname;
    return KNOWN_JE_PROVIDER_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/** 兼容旧接口命名。 */
export function isOfficialProvider(providerOrigin: string | null): boolean {
  return isSupportedProvider(providerOrigin);
}

/** 按响应报告的模型版本查找费率；别名或未知模型返回 null。 */
export function findPriceVersion(
  responseModel: string | null | undefined,
): PriceVersion | null {
  if (typeof responseModel !== "string") return null;
  const model = responseModel.trim();
  if (!model) return null;
  for (const price of PRICE_VERSIONS) {
    if (price.modelIds.includes(model)) return price;
  }
  return null;
}

export interface EstimateCostInput {
  inputTokens: number | null;
  outputTokens: number | null;
  responseModel: string | null;
  providerOrigin: string | null;
}

/**
 * 按响应用量与模型/费率快照估算费用。
 * 判断顺序：provider → 响应模型 → 输入用量；任一不可核实即未知。
 */
export function estimateCost(input: EstimateCostInput): CostEstimate {
  const unknown = (reason: string): CostEstimate => ({
    costStatus: "unknown",
    unknownReason: reason,
    priceVersion: null,
    inputRateNanosPerToken: null,
    estimatedUsdNanos: null,
  });

  if (!isSupportedProvider(input.providerOrigin)) {
    return unknown("非官方或未支持的 Jev 服务端，无可用公布费率");
  }

  const price = findPriceVersion(input.responseModel);
  if (!price) {
    return unknown(
      input.responseModel
        ? `未知模型价格（响应模型：${input.responseModel}）`
        : "响应未报告模型版本，无法套用公布费率",
    );
  }

  const inputTokens = parseTokenCount(input.inputTokens);
  if (inputTokens === null) {
    return unknown("上游未报告输入用量，无法按输入费率计价");
  }

  // 输出用量缺失不影响仅输入计费：输出费率为 0 时缺失输出用量仍可精确计价。
  const outputTokens = parseTokenCount(input.outputTokens) ?? 0;
  const totalNanos =
    inputTokens * price.inputNanosPerToken +
    outputTokens * price.outputNanosPerToken;

  if (!Number.isSafeInteger(totalNanos)) {
    return unknown("用量超出可精确计价范围");
  }

  return {
    costStatus: "known",
    unknownReason: null,
    priceVersion: price.version,
    inputRateNanosPerToken: price.inputNanosPerToken,
    estimatedUsdNanos: totalNanos,
  };
}

/**
 * 把纳美元金额格式化为美元字符串。
 * 已知的极小正数必须显示为非零（例如 42 纳美元 → $0.000000042），不能舍入成 $0.00。
 */
export function formatUsdFromNanos(nanos: number): string {
  if (!Number.isFinite(nanos) || nanos <= 0) return "0.00";
  const dollars = nanos / 1_000_000_000;
  const fixed = dollars.toFixed(9);
  const trimmed = fixed.replace(/0+$/, "");
  const [intPart, fracPart = ""] = trimmed.split(".");
  const padded = fracPart.padEnd(2, "0");
  return `${intPart}.${padded}`;
}
