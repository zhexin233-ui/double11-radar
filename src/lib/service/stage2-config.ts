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

export const STAGE2_SETTING_NAMESPACE = "stage2";
export const STAGE2_LLM_SECRET_NAMESPACE = "stage2.llmApiKey";

export const DEFAULT_STAGE2_LLM_CONFIG: Stage2LlmConfig = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutMs: 25_000,
  maxSteps: 5,
  temperature: 0.1,
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

export function getStage2Config(
  db: Database.Database,
  key?: Buffer,
): Stage2ConfigSnapshot {
  const row = getSetting<Partial<Stage2Config>>(db, STAGE2_SETTING_NAMESPACE);
  const raw = row?.value;
  const rawLlm = raw?.llm as Partial<Stage2LlmConfig> | undefined;

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
      baseUrl: normalizeHttpUrl(
        rawLlm?.baseUrl,
        DEFAULT_STAGE2_LLM_CONFIG.baseUrl,
      ),
      model:
        typeof rawLlm?.model === "string" && rawLlm.model.trim()
          ? rawLlm.model.trim()
          : DEFAULT_STAGE2_LLM_CONFIG.model,
      timeoutMs: clampInt(
        rawLlm?.timeoutMs,
        DEFAULT_STAGE2_LLM_CONFIG.timeoutMs,
        3_000,
        120_000,
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

    const nextLlm: Stage2LlmConfig = {
      baseUrl:
        input.llm?.baseUrl !== undefined
          ? validateHttpUrlOrThrow(input.llm.baseUrl, "二级 LLM 服务地址")
          : current.config.llm.baseUrl,
      model:
        input.llm?.model !== undefined
          ? (() => {
              const m = String(input.llm.model).trim();
              if (!m) {
                throw new HttpError("INVALID_MODEL", "二级模型名称不能为空", 400);
              }
              return m;
            })()
          : current.config.llm.model,
      timeoutMs:
        input.llm?.timeoutMs !== undefined
          ? clampInt(input.llm.timeoutMs, current.config.llm.timeoutMs, 3_000, 120_000)
          : current.config.llm.timeoutMs,
      maxSteps:
        input.llm?.maxSteps !== undefined
          ? clampInt(input.llm.maxSteps, current.config.llm.maxSteps, 1, 8)
          : current.config.llm.maxSteps,
      temperature:
        input.llm?.temperature !== undefined
          ? clampFloat(input.llm.temperature, current.config.llm.temperature, 0, 2)
          : current.config.llm.temperature,
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
