import type Database from "better-sqlite3";
import {
  getSecret,
  getSetting,
  setSetting,
} from "@/lib/db/repos/settings";
import type { Stage2Config, Stage2LlmConfig } from "@/lib/domain/types";
import { HttpError } from "@/lib/http/json";
import {
  applySecretInput,
  readSecretStateMasked,
  type SecretInput,
  type SecretState,
} from "@/lib/service/config";
import { isDirectOpenRouterBaseUrl } from "@/lib/stage2/pricing";

export const STAGE2_SETTING_NAMESPACE = "stage2";
export const STAGE2_LLM_SECRET_NAMESPACE = "stage2.llmApiKey";
export const STAGE2_LLM_TIMEOUT_MIN_MS = 3_000;
export const STAGE2_LLM_TIMEOUT_MAX_MS = 180_000;

export const DEFAULT_STAGE2_LLM_CONFIG: Stage2LlmConfig = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutMs: 180_000,
  maxSteps: 5,
  temperature: 0.1,
  inputUsdPerMillion: null,
  outputUsdPerMillion: null,
  openRouterModelId: null,
};

export const DEFAULT_STAGE2_CONFIG: Stage2Config = {
  enabled: false,
  includeUncertain: false,
  notifyOnInsufficientInfo: false,
  fallbackToStage1Notify: true,
  concurrency: 1,
  llm: { ...DEFAULT_STAGE2_LLM_CONFIG },
};

export interface Stage2ConfigSnapshot {
  config: Stage2Config;
  version: number;
  apiKeyState: SecretState;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeHttpUrl(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    return trimmed;
  } catch {
    return fallback;
  }
}

export function validateHttpUrlOrThrow(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError("INVALID_URL", `${fieldName} 不能为空`, 400);
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError("INVALID_URL", `${fieldName} 不是合法的 URL`, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      "INVALID_URL",
      `${fieldName} 仅支持 http:// 或 https://`,
      400,
    );
  }
  return trimmed;
}

function normalizeOptionalRate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  if (raw > 1_000_000) return null;
  return raw;
}

export function validateOptionalRateOrThrow(
  raw: unknown,
  fieldName: string,
): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new HttpError(
      "INVALID_RATE",
      `${fieldName}必须为非负数字或留空`,
      400,
    );
  }
  if (raw > 1_000_000) {
    throw new HttpError(
      "INVALID_RATE",
      `${fieldName}超出允许范围（最大 1,000,000 美元/百万 Token）`,
      400,
    );
  }
  return raw;
}

function normalizeOptionalOpenRouterModelId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

export function getStage2Config(
  db: Database.Database,
  key?: Buffer,
): Stage2ConfigSnapshot {
  const row = getSetting<Partial<Stage2Config>>(db, STAGE2_SETTING_NAMESPACE);
  const raw = row?.value;
  const rawLlm = raw?.llm as Partial<Stage2LlmConfig> | undefined;

  const baseUrl = normalizeHttpUrl(
    rawLlm?.baseUrl,
    DEFAULT_STAGE2_LLM_CONFIG.baseUrl,
  );
  const directOpenRouter = isDirectOpenRouterBaseUrl(baseUrl);

  const config: Stage2Config = {
    enabled:
      typeof raw?.enabled === "boolean"
        ? raw.enabled
        : DEFAULT_STAGE2_CONFIG.enabled,
    includeUncertain:
      typeof raw?.includeUncertain === "boolean"
        ? raw.includeUncertain
        : DEFAULT_STAGE2_CONFIG.includeUncertain,
    notifyOnInsufficientInfo:
      typeof raw?.notifyOnInsufficientInfo === "boolean"
        ? raw.notifyOnInsufficientInfo
        : DEFAULT_STAGE2_CONFIG.notifyOnInsufficientInfo,
    fallbackToStage1Notify:
      typeof raw?.fallbackToStage1Notify === "boolean"
        ? raw.fallbackToStage1Notify
        : DEFAULT_STAGE2_CONFIG.fallbackToStage1Notify,
    concurrency: clampInt(
      raw?.concurrency,
      DEFAULT_STAGE2_CONFIG.concurrency,
      1,
      4,
    ),
    llm: {
      baseUrl,
      model:
        typeof rawLlm?.model === "string" && rawLlm.model.trim()
          ? rawLlm.model.trim()
          : DEFAULT_STAGE2_LLM_CONFIG.model,
      timeoutMs: clampInt(
        rawLlm?.timeoutMs,
        DEFAULT_STAGE2_LLM_CONFIG.timeoutMs,
        STAGE2_LLM_TIMEOUT_MIN_MS,
        STAGE2_LLM_TIMEOUT_MAX_MS,
      ),
      maxSteps: clampInt(
        rawLlm?.maxSteps,
        DEFAULT_STAGE2_LLM_CONFIG.maxSteps,
        1,
        8,
      ),
      temperature: clampFloat(
        rawLlm?.temperature,
        DEFAULT_STAGE2_LLM_CONFIG.temperature,
        0,
        2,
      ),
      inputUsdPerMillion: normalizeOptionalRate(rawLlm?.inputUsdPerMillion),
      outputUsdPerMillion: normalizeOptionalRate(rawLlm?.outputUsdPerMillion),
      openRouterModelId: directOpenRouter
        ? null
        : normalizeOptionalOpenRouterModelId(rawLlm?.openRouterModelId),
    },
  };

  return {
    config,
    version: row?.version ?? 0,
    apiKeyState: readSecretStateMasked(db, STAGE2_LLM_SECRET_NAMESPACE, key),
  };
}

export function readStage2LlmApiKey(
  db: Database.Database,
  key?: Buffer,
): { apiKey: string | null; unreadable: boolean } {
  try {
    const value = getSecret(db, STAGE2_LLM_SECRET_NAMESPACE, key);
    return { apiKey: value, unreadable: false };
  } catch {
    return { apiKey: null, unreadable: true };
  }
}

export interface UpdateStage2ConfigInput {
  enabled?: boolean;
  includeUncertain?: boolean;
  notifyOnInsufficientInfo?: boolean;
  fallbackToStage1Notify?: boolean;
  concurrency?: number;
  llm?: Partial<Stage2LlmConfig>;
  apiKey?: SecretInput;
  expectedVersion?: number;
}

export function updateStage2Config(
  db: Database.Database,
  input: UpdateStage2ConfigInput,
  key?: Buffer,
): Stage2ConfigSnapshot {
  const tx = db.transaction(() => {
    const current = getStage2Config(db, key);
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== current.version
    ) {
      throw new HttpError(
        "VERSION_CONFLICT",
        "二级核验配置已被其他操作更新，请刷新后重试",
        409,
      );
    }

    const nextBaseUrl =
      input.llm?.baseUrl !== undefined
        ? validateHttpUrlOrThrow(input.llm.baseUrl, "二级 LLM 服务地址")
        : current.config.llm.baseUrl;
    const nextModel =
      input.llm?.model !== undefined
        ? (() => {
            const m = String(input.llm.model).trim();
            if (!m) {
              throw new HttpError("INVALID_MODEL", "二级模型名称不能为空", 400);
            }
            return m;
          })()
        : current.config.llm.model;

    const modelOrEndpointChanged =
      nextBaseUrl !== current.config.llm.baseUrl ||
      nextModel !== current.config.llm.model;
    const directOpenRouter = isDirectOpenRouterBaseUrl(nextBaseUrl);

    const nextInputUsdPerMillion =
      input.llm?.inputUsdPerMillion !== undefined
        ? validateOptionalRateOrThrow(
            input.llm.inputUsdPerMillion,
            "手动输入单价",
          )
        : modelOrEndpointChanged
          ? null
          : current.config.llm.inputUsdPerMillion;

    const nextOutputUsdPerMillion =
      input.llm?.outputUsdPerMillion !== undefined
        ? validateOptionalRateOrThrow(
            input.llm.outputUsdPerMillion,
            "手动输出单价",
          )
        : modelOrEndpointChanged
          ? null
          : current.config.llm.outputUsdPerMillion;

    const nextOpenRouterModelId = directOpenRouter
      ? null
      : input.llm?.openRouterModelId !== undefined
        ? normalizeOptionalOpenRouterModelId(input.llm.openRouterModelId)
        : modelOrEndpointChanged
          ? null
          : current.config.llm.openRouterModelId;

    const nextLlm: Stage2LlmConfig = {
      baseUrl: nextBaseUrl,
      model: nextModel,
      timeoutMs:
        input.llm?.timeoutMs !== undefined
          ? clampInt(
              input.llm.timeoutMs,
              current.config.llm.timeoutMs,
              STAGE2_LLM_TIMEOUT_MIN_MS,
              STAGE2_LLM_TIMEOUT_MAX_MS,
            )
          : current.config.llm.timeoutMs,
      maxSteps:
        input.llm?.maxSteps !== undefined
          ? clampInt(input.llm.maxSteps, current.config.llm.maxSteps, 1, 8)
          : current.config.llm.maxSteps,
      temperature:
        input.llm?.temperature !== undefined
          ? clampFloat(input.llm.temperature, current.config.llm.temperature, 0, 2)
          : current.config.llm.temperature,
      inputUsdPerMillion: nextInputUsdPerMillion,
      outputUsdPerMillion: nextOutputUsdPerMillion,
      openRouterModelId: nextOpenRouterModelId,
    };

    const nextConfig: Stage2Config = {
      enabled:
        typeof input.enabled === "boolean"
          ? input.enabled
          : current.config.enabled,
      includeUncertain:
        typeof input.includeUncertain === "boolean"
          ? input.includeUncertain
          : current.config.includeUncertain,
      notifyOnInsufficientInfo:
        typeof input.notifyOnInsufficientInfo === "boolean"
          ? input.notifyOnInsufficientInfo
          : current.config.notifyOnInsufficientInfo,
      fallbackToStage1Notify:
        typeof input.fallbackToStage1Notify === "boolean"
          ? input.fallbackToStage1Notify
          : current.config.fallbackToStage1Notify,
      concurrency:
        input.concurrency !== undefined
          ? clampInt(input.concurrency, current.config.concurrency, 1, 4)
          : current.config.concurrency,
      llm: nextLlm,
    };

    setSetting(db, STAGE2_SETTING_NAMESPACE, nextConfig);
    if (input.apiKey !== undefined) {
      applySecretInput(db, STAGE2_LLM_SECRET_NAMESPACE, input.apiKey, key);
    }

    return getStage2Config(db, key);
  });

  return tx.immediate();
}

export interface Stage2DraftTestPricingInput {
  baseUrl: string;
  model: string;
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
  openRouterModelId?: string | null;
}

/**
 * 解析连接测试草稿所使用的费率与参考模型 ID。
 * 当模型或端点相对已保存配置发生变化且草稿未显式传入价格字段时，绝不继承旧模型的已保存手动费率或参考 ID。
 */
export function resolveStage2DraftTestPricing(
  saved: Stage2LlmConfig,
  draft: Stage2DraftTestPricingInput,
): {
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  openRouterModelId: string | null;
} {
  const modelOrEndpointChanged =
    draft.baseUrl !== saved.baseUrl || draft.model !== saved.model;
  const directOpenRouter = isDirectOpenRouterBaseUrl(draft.baseUrl);

  const inputUsdPerMillion =
    draft.inputUsdPerMillion !== undefined
      ? validateOptionalRateOrThrow(draft.inputUsdPerMillion, "手动输入单价")
      : modelOrEndpointChanged
        ? null
        : saved.inputUsdPerMillion;

  const outputUsdPerMillion =
    draft.outputUsdPerMillion !== undefined
      ? validateOptionalRateOrThrow(draft.outputUsdPerMillion, "手动输出单价")
      : modelOrEndpointChanged
        ? null
        : saved.outputUsdPerMillion;

  const openRouterModelId = directOpenRouter
    ? null
    : draft.openRouterModelId !== undefined
      ? normalizeOptionalOpenRouterModelId(draft.openRouterModelId)
      : modelOrEndpointChanged
        ? null
        : saved.openRouterModelId;

  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    openRouterModelId,
  };
}
