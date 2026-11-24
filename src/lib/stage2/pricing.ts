import type {
  JevCostStatus,
  OpenRouterModelPrice,
  Stage2PriceSource,
  Stage2ResolvedRate,
} from "@/lib/domain/types";
import { parseTokenCount, providerOriginFromBaseUrl } from "@/lib/jev/pricing";

/**
 * 二级核验模型定价与 OpenRouter 公开目录解码（纯函数，无 I/O）。
 *
 * 契约要点：
 * - 费率快照按「美元 / 百万 Token」保存，保留小数精度，避免截断为每 Token 整数纳美元；
 * - 严格按完整模型 ID 精确匹配，绝不剥离 `:free`、`:online` 等后缀；
 * - 仅当实际请求端点为 HTTPS OpenRouter 官方默认端口（`https://openrouter.ai`）时自动按模型 ID 匹配；
 * - 自定义端点仅使用显式配置的 OpenRouter 参考模型 ID；
 * - 手填费率按输入/输出方向独立覆盖目录价，明确填写 0 表示免费且不被目录覆盖；
 * - 估算金额按整数纳美元保存，校验 `Number.isSafeInteger`，极小正费用最小取 1 纳美元，绝不把正费用舍入为 $0.00。
 */

export const OPENROUTER_OFFICIAL_ORIGIN = "https://openrouter.ai";

/** 严格判断是否为直连 HTTPS OpenRouter 官方端点（默认 443 端口）。 */
export function isDirectOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl.trim());
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "openrouter.ai" &&
      (parsed.port === "" || parsed.port === "443")
    );
  } catch {
    return false;
  }
}

export function isDirectOpenRouterOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return origin.toLowerCase() === OPENROUTER_OFFICIAL_ORIGIN;
}

/**
 * 解析 OpenRouter 单 Token 美元价并换算为「美元 / 百万 Token」。
 * 只接受有限非负值（保留真实 0）；缺失、负值（如 -1）、NaN、非数字均返回 null。
 */
export function parseOpenRouterPerTokenToPerMillion(
  raw: unknown,
): number | null {
  let perToken: number;
  if (typeof raw === "number") {
    perToken = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    perToken = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  if (perToken === 0) return 0;
  const perMillion = perToken * 1_000_000;
  if (!Number.isFinite(perMillion) || perMillion < 0) return null;
  return Number(perMillion.toPrecision(12));
}

export type DecodeOpenRouterCatalogResult =
  | {
      ok: true;
      models: Record<string, OpenRouterModelPrice>;
      modelCount: number;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * 解码 OpenRouter `/api/v1/models` 响应，仅保留精简的 `{ id -> { inputUsdPerMillion, outputUsdPerMillion } }` 映射。
 */
export function decodeOpenRouterModelsPayload(
  raw: unknown,
): DecodeOpenRouterCatalogResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "OpenRouter 目录响应格式异常（非 JSON 对象）" };
  }
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { ok: false, error: "OpenRouter 目录响应缺少 data 数组" };
  }

  const models: Record<string, OpenRouterModelPrice> = Object.create(null);
  let count = 0;

  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawId = (item as { id?: unknown }).id;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!id) continue;

    const pricing = (item as { pricing?: unknown }).pricing;
    const pricingObj =
      pricing && typeof pricing === "object" && !Array.isArray(pricing)
        ? (pricing as { prompt?: unknown; completion?: unknown })
        : null;

    const inputUsdPerMillion = parseOpenRouterPerTokenToPerMillion(
      pricingObj?.prompt,
    );
    const outputUsdPerMillion = parseOpenRouterPerTokenToPerMillion(
      pricingObj?.completion,
    );

    if (!Object.hasOwn(models, id)) {
      count += 1;
    }
    models[id] = { inputUsdPerMillion, outputUsdPerMillion };
  }

  if (count === 0) {
    return { ok: false, error: "OpenRouter 目录响应未包含任何有效模型记录" };
  }

  return { ok: true, models, modelCount: count };
}

export interface OpenRouterCatalogSnapshot {
  models: Record<string, OpenRouterModelPrice>;
  snapshotVersion: string | null;
}

export interface ResolveStage2RatesInput {
  baseUrl?: string | null;
  providerOrigin?: string | null;
  requestedModel: string;
  responseModel?: string | null;
  manualInputUsdPerMillion: number | null;
  manualOutputUsdPerMillion: number | null;
  openRouterModelId: string | null;
  catalog: OpenRouterCatalogSnapshot | null;
}

function isValidManualRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 解析当前请求或配置的有效输入/输出费率（美元 / 百万 Token）与来源。
 */
export function resolveStage2Rates(
  input: ResolveStage2RatesInput,
): Stage2ResolvedRate {
  const origin =
    input.providerOrigin !== undefined
      ? input.providerOrigin
      : input.baseUrl
        ? providerOriginFromBaseUrl(input.baseUrl)
        : null;
  const isDirect = isDirectOpenRouterOrigin(origin);

  let lookupModelId: string | null = null;
  if (isDirect) {
    const respModel = input.responseModel?.trim();
    const reqModel = input.requestedModel.trim();
    lookupModelId = respModel || reqModel || null;
  } else {
    const refId = input.openRouterModelId?.trim();
    lookupModelId = refId || null;
  }

  const catalogEntry =
    lookupModelId &&
    input.catalog &&
    Object.hasOwn(input.catalog.models, lookupModelId)
      ? input.catalog.models[lookupModelId]
      : null;

  let inputUsdPerMillion: number | null = null;
  let inputSource: Stage2PriceSource = "unknown";
  if (isValidManualRate(input.manualInputUsdPerMillion)) {
    inputUsdPerMillion = input.manualInputUsdPerMillion;
    inputSource = "manual";
  } else if (catalogEntry && catalogEntry.inputUsdPerMillion !== null) {
    inputUsdPerMillion = catalogEntry.inputUsdPerMillion;
    inputSource = "openrouter";
  }

  let outputUsdPerMillion: number | null = null;
  let outputSource: Stage2PriceSource = "unknown";
  if (isValidManualRate(input.manualOutputUsdPerMillion)) {
    outputUsdPerMillion = input.manualOutputUsdPerMillion;
    outputSource = "manual";
  } else if (catalogEntry && catalogEntry.outputUsdPerMillion !== null) {
    outputUsdPerMillion = catalogEntry.outputUsdPerMillion;
    outputSource = "openrouter";
  }

  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    inputSource,
    outputSource,
    matchedCatalogModelId: catalogEntry ? lookupModelId : null,
    catalogVersion: catalogEntry ? (input.catalog?.snapshotVersion ?? null) : null,
    isDirectOpenRouter: isDirect,
  };
}

export interface Stage2CostEstimate {
  costStatus: JevCostStatus;
  unknownReason: string | null;
  priceVersion: string | null;
  inputRateUsdPerMillion: number | null;
  outputRateUsdPerMillion: number | null;
  inputRateSource: Stage2PriceSource;
  outputRateSource: Stage2PriceSource;
  matchedCatalogModelId: string | null;
  estimatedUsdNanos: number | null;
}

function buildPriceVersion(rates: Stage2ResolvedRate): string | null {
  const usesManual =
    rates.inputSource === "manual" || rates.outputSource === "manual";
  const usesCatalog =
    rates.inputSource === "openrouter" || rates.outputSource === "openrouter";
  if (usesManual && usesCatalog) {
    return `manual+${rates.catalogVersion ?? "openrouter"}`;
  }
  if (usesManual) return "manual";
  if (usesCatalog) return rates.catalogVersion ?? "openrouter";
  return null;
}

/**
 * 基于解析后的费率快照与 Token 用量估算单次二级调用费用（整数纳美元）。
 */
export function estimateStage2Cost(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  rates: Stage2ResolvedRate;
}): Stage2CostEstimate {
  const { rates } = input;
  const priceVersion = buildPriceVersion(rates);

  const unknown = (reason: string): Stage2CostEstimate => ({
    costStatus: "unknown",
    unknownReason: reason,
    priceVersion,
    inputRateUsdPerMillion: rates.inputUsdPerMillion,
    outputRateUsdPerMillion: rates.outputUsdPerMillion,
    inputRateSource: rates.inputSource,
    outputRateSource: rates.outputSource,
    matchedCatalogModelId: rates.matchedCatalogModelId,
    estimatedUsdNanos: null,
  });

  const inTok = parseTokenCount(input.inputTokens);
  const outTok = parseTokenCount(input.outputTokens);

  // 无任何可用 Token 的响应保留未知金额（即使费率为 0 也不伪造零账单）
  if (inTok === null && outTok === null) {
    return unknown("上游未报告可用 Token 用量");
  }

  if (rates.inputUsdPerMillion === null && rates.outputUsdPerMillion === null) {
    return unknown("模型输入与输出费率未知");
  }
  if (rates.inputUsdPerMillion === null) {
    return unknown("模型输入费率未知");
  }
  if (rates.outputUsdPerMillion === null) {
    return unknown("模型输出费率未知");
  }

  if (rates.inputUsdPerMillion > 0 && inTok === null) {
    return unknown("上游未报告输入 Token 用量，无法按输入费率计价");
  }
  if (rates.outputUsdPerMillion > 0 && outTok === null) {
    return unknown("上游未报告输出 Token 用量，无法按输出费率计价");
  }

  const effectiveIn = inTok ?? 0;
  const effectiveOut = outTok ?? 0;

  const rawNanos =
    (effectiveIn * rates.inputUsdPerMillion +
      effectiveOut * rates.outputUsdPerMillion) *
    1000;

  if (!Number.isFinite(rawNanos) || rawNanos < 0) {
    return unknown("用量超出可精确计价范围");
  }

  let nanos = Math.round(rawNanos);
  if (!Number.isSafeInteger(nanos)) {
    return unknown("用量超出可精确计价范围");
  }

  // 最小 1 纳美元保护：存在正价方向且对应正 Token，绝不舍入为 $0.00
  const hasPositiveCharge =
    (rates.inputUsdPerMillion > 0 && effectiveIn > 0) ||
    (rates.outputUsdPerMillion > 0 && effectiveOut > 0);
  if (hasPositiveCharge && nanos === 0) {
    nanos = 1;
  }

  return {
    costStatus: "known",
    unknownReason: null,
    priceVersion,
    inputRateUsdPerMillion: rates.inputUsdPerMillion,
    outputRateUsdPerMillion: rates.outputUsdPerMillion,
    inputRateSource: rates.inputSource,
    outputRateSource: rates.outputSource,
    matchedCatalogModelId: rates.matchedCatalogModelId,
    estimatedUsdNanos: nanos,
  };
}
