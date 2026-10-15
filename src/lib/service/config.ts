import type Database from "better-sqlite3";
import {
  clearSecret,
  getSecret,
  getSetting,
  setSecret,
  setSetting,
} from "@/lib/db/repos/settings";
import {
  createJevKey,
  getJevKey,
  listJevKeys,
  updateJevKey,
} from "@/lib/db/repos/jev-keys";
import {
  applyChannelSelection,
  DEFAULT_CHANNEL_SELECTION,
  getChannelSelection,
  saveChannelSelection,
  syncChannelsFromCatalog,
  type ChannelCatalogEntry,
  type ChannelSelection,
} from "@/lib/db/repos/channels";
import {
  LEGACY_JEV_KEY_ID,
  LEGACY_JEV_KEY_NAMESPACE,
} from "@/lib/db/migrations";
import {
  DEFAULT_JE_BASE_URL,
  DEFAULT_JE_MODEL,
  DEFAULT_JE_TIMEOUT_MS,
} from "@/lib/jev/client";
import type { AppEnv } from "@/lib/env";

/**
 * 配置读写服务（Jev / 采集选择 / 推送渠道）。
 *
 * 三态凭据语义：`undefined`/`null` → 保留；`''` 空串 → 保留（空串不是清除指令）；
 * `{ clear: true }` → 显式清除；字符串 → 替换。
 * 读取只返回 `configured` 与掩码，绝不回传可还原的明文。
 */

export const JE_SETTING_NAMESPACE = "jev";
export const NOTIFY_SETTING_NAMESPACE = "notify";

export const SECRET_NAMESPACES = {
  jevApiKey: "jev.apiKey",
  barkDeviceKey: "bark.deviceKey",
  feishuWebhook: "feishu.webhook",
  feishuSigningSecret: "feishu.signingSecret",
} as const;

export interface SecretState {
  configured: boolean;
  masked: string | null;
  /** 已配置但当前加密密钥无法解密（例如 APP_ENCRYPTION_KEY 已变更）。 */
  unreadable: boolean;
}

export type SecretInput = string | { clear: true } | null | undefined;

function maskSecret(value: string): string {
  const visible = value.slice(-4);
  return `****${visible}`;
}

/**
 * 读取凭据掩码。
 * 解密失败（通常是 APP_ENCRYPTION_KEY 变更）不抛异常，而是标记 `unreadable`，
 * 使配置页可以给出明确提示而不是整个页面报 500。
 */
export function readSecretStateMasked(
  db: Database.Database,
  namespace: string,
  key?: Buffer,
): SecretState {
  try {
    const value = getSecret(db, namespace, key);
    if (value === null) {
      return { configured: false, masked: null, unreadable: false };
    }
    return { configured: true, masked: maskSecret(value), unreadable: false };
  } catch (error) {
    console.error(`[config] 凭据 ${namespace} 无法解密：`, error);
    return { configured: true, masked: null, unreadable: true };
  }
}

/**
 * 按三态语义写入凭据。返回是否发生变更。
 */
export function applySecretInput(
  db: Database.Database,
  namespace: string,
  input: SecretInput,
  key?: Buffer,
): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "object") {
    if (input.clear === true) {
      return clearSecret(db, namespace);
    }
    return false;
  }
  const value = input.trim();
  if (value === "") return false;
  if (key) {
    setSecret(db, namespace, value, key);
  } else {
    setSecret(db, namespace, value);
  }
  return true;
}

// ── Jev 配置 ────────────────────────────────────────────────────────────────

export interface JevConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 同时进行的 Jev 请求数上限（1 = 严格串行）。 */
  concurrency: number;
  /** 每轮最多领取并处理的判断任务数。 */
  jobsPerRound: number;
}

/** 并发上限：默认串行，允许小幅提高，但不放任打满上游。 */
export const MIN_JE_CONCURRENCY = 1;
export const MAX_JE_CONCURRENCY = 8;
export const MIN_JOBS_PER_ROUND = 1;
export const MAX_JOBS_PER_ROUND = 50;
export const DEFAULT_JE_CONCURRENCY = 1;
export const DEFAULT_JE_JOBS_PER_ROUND = 3;

export interface JevConfigView {
  config: JevConfig;
  apiKey: SecretState;
  version: number;
}

const DEFAULT_JE_CONFIG: JevConfig = {
  baseUrl: DEFAULT_JE_BASE_URL,
  model: DEFAULT_JE_MODEL,
  timeoutMs: DEFAULT_JE_TIMEOUT_MS,
  concurrency: DEFAULT_JE_CONCURRENCY,
  jobsPerRound: DEFAULT_JE_JOBS_PER_ROUND,
};

/** 把整数限制在 [min, max]；非法值回退到 fallback。 */
function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function getJevConfig(db: Database.Database): JevConfig {
  const record = getSetting<Partial<JevConfig>>(db, JE_SETTING_NAMESPACE);
  const value = record?.value ?? {};
  return {
    baseUrl:
      typeof value.baseUrl === "string" && value.baseUrl.trim()
        ? value.baseUrl.trim()
        : DEFAULT_JE_CONFIG.baseUrl,
    model:
      typeof value.model === "string" && value.model.trim()
        ? value.model.trim()
        : DEFAULT_JE_CONFIG.model,
    timeoutMs:
      typeof value.timeoutMs === "number" && value.timeoutMs > 0
        ? value.timeoutMs
        : DEFAULT_JE_CONFIG.timeoutMs,
    concurrency: clampInt(
      value.concurrency,
      MIN_JE_CONCURRENCY,
      MAX_JE_CONCURRENCY,
      DEFAULT_JE_CONFIG.concurrency,
    ),
    jobsPerRound: clampInt(
      value.jobsPerRound,
      MIN_JOBS_PER_ROUND,
      MAX_JOBS_PER_ROUND,
      DEFAULT_JE_CONFIG.jobsPerRound,
    ),
  };
}

export function getJevConfigView(
  db: Database.Database,
  key?: Buffer,
): JevConfigView {
  const record = getSetting(db, JE_SETTING_NAMESPACE);
  return {
    config: getJevConfig(db),
    // 兼容层：旧单 Key 字段映射到迁移后固定的兼容 Key。
    apiKey: readSecretStateMasked(db, LEGACY_JEV_KEY_NAMESPACE, key),
    version: record?.version ?? 0,
  };
}

export interface SaveJevConfigInput {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  concurrency?: number;
  jobsPerRound?: number;
  apiKey?: SecretInput;
}

export function saveJevConfig(
  db: Database.Database,
  input: SaveJevConfigInput,
  key?: Buffer,
): JevConfigView {
  const current = getJevConfig(db);
  const next: JevConfig = {
    baseUrl:
      typeof input.baseUrl === "string" && input.baseUrl.trim()
        ? input.baseUrl.trim()
        : current.baseUrl,
    model:
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : current.model,
    timeoutMs:
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? input.timeoutMs
        : current.timeoutMs,
    concurrency:
      input.concurrency === undefined
        ? current.concurrency
        : clampInt(
            input.concurrency,
            MIN_JE_CONCURRENCY,
            MAX_JE_CONCURRENCY,
            current.concurrency,
          ),
    jobsPerRound:
      input.jobsPerRound === undefined
        ? current.jobsPerRound
        : clampInt(
            input.jobsPerRound,
            MIN_JOBS_PER_ROUND,
            MAX_JOBS_PER_ROUND,
            current.jobsPerRound,
          ),
  };
  // 基础配置与兼容 Key 的密文/元数据必须在同一事务内落库；
  // 只改普通配置时不得重置 Key 计数或误启用已禁用的 Key。
  const run = db.transaction(() => {
    setSetting(db, JE_SETTING_NAMESPACE, next);
    applyLegacyJevKeyInput(db, input.apiKey, key);
  });
  run.immediate();
  return getJevConfigView(db, key);
}

/**
 * 兼容层：把旧单 `apiKey` 三态映射到固定的兼容 Key。
 * 保存新密钥等价于「替换并启用」；清除则同时停用该 Key。
 */
function applyLegacyJevKeyInput(
  db: Database.Database,
  input: SecretInput,
  key?: Buffer,
): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "object") {
    if (input.clear === true) {
      const existing = getJevKey(db, LEGACY_JEV_KEY_ID);
      if (!existing) return false;
      const cleared = clearSecret(db, existing.secretNamespace);
      updateJevKey(db, existing.id, {
        enabled: false,
        disabledReason: "密钥已清除，请替换后再启用",
        consecutiveFailures: 0,
        bumpGeneration: true,
      });
      return cleared;
    }
    return false;
  }
  const value = input.trim();
  if (value === "") return false;
  const existing =
    getJevKey(db, LEGACY_JEV_KEY_ID) ??
    createJevKey(db, {
      id: LEGACY_JEV_KEY_ID,
      label: "兼容单密钥",
      secretNamespace: LEGACY_JEV_KEY_NAMESPACE,
    });
  setSecret(db, existing.secretNamespace, value, key);
  updateJevKey(db, existing.id, {
    enabled: true,
    consecutiveFailures: 0,
    disabledReason: null,
    lastError: null,
    cooldownUntil: null,
    bumpGeneration: true,
  });
  return true;
}

// ── Jev 运行时 Key ───────────────────────────────────────────────────────────

/** 调度使用的运行时 Key：已启用且密文可解密，仅在服务端持有明文。 */
export interface JevRuntimeKey {
  id: string;
  label: string;
  generation: number;
  apiKey: string;
}

/**
 * 列出可参与调度的 Key。解密失败属于本地配置错误：只跳过并记录日志，
 * **不**计作上游失败，也不会因此禁用 Key。
 */
export function listJevRuntimeKeys(
  db: Database.Database,
  key?: Buffer,
): JevRuntimeKey[] {
  const runtime: JevRuntimeKey[] = [];
  for (const row of listJevKeys(db)) {
    if (!row.enabled) continue;
    let apiKey: string | null = null;
    try {
      apiKey = getSecret(db, row.secretNamespace, key);
    } catch (error) {
      console.error(`[config] 凭据 ${row.secretNamespace} 无法解密：`, error);
      continue;
    }
    if (!apiKey) continue;
    runtime.push({
      id: row.id,
      label: row.label,
      generation: row.generation,
      apiKey,
    });
  }
  return runtime;
}

/**
 * 供 worker / 测试使用的单 Key 兼容视图：优先兼容 Key，否则取第一个可用 Key。
 * 池内没有任何可用 Key 时返回 null。
 */
export function getJevRuntimeConfig(
  db: Database.Database,
  key?: Buffer,
): (JevConfig & { apiKey: string }) | null {
  const runtimeKeys = listJevRuntimeKeys(db, key);
  if (runtimeKeys.length === 0) return null;
  const preferred =
    runtimeKeys.find((candidate) => candidate.id === LEGACY_JEV_KEY_ID) ??
    runtimeKeys[0];
  return { ...getJevConfig(db), apiKey: preferred.apiKey };
}

// ── 采集频道选择 ─────────────────────────────────────────────────────────────
export { getChannelSelection, saveChannelSelection, applyChannelSelection };
export type { ChannelSelection, ChannelCatalogEntry };
export { DEFAULT_CHANNEL_SELECTION };

export function syncChannels(
  db: Database.Database,
  entries: ChannelCatalogEntry[],
): void {
  syncChannelsFromCatalog(db, entries, getChannelSelection(db));
}

// ── 推送渠道配置 ─────────────────────────────────────────────────────────────

export interface BarkStoredConfig {
  enabled: boolean;
  serverUrl: string;
}

export interface FeishuStoredConfig {
  enabled: boolean;
  keywordPrefix: string;
  signingEnabled: boolean;
}

export interface NotifyStoredConfig {
  bark: BarkStoredConfig;
  feishu: FeishuStoredConfig;
}

export const DEFAULT_BARK_SERVER = "https://api.day.app";

const DEFAULT_NOTIFY_CONFIG: NotifyStoredConfig = {
  bark: { enabled: false, serverUrl: DEFAULT_BARK_SERVER },
  feishu: { enabled: false, keywordPrefix: "", signingEnabled: false },
};

export function getNotifyStoredConfig(db: Database.Database): NotifyStoredConfig {
  const record = getSetting<Partial<NotifyStoredConfig>>(
    db,
    NOTIFY_SETTING_NAMESPACE,
  );
  const value = record?.value ?? {};
  const bark: Partial<BarkStoredConfig> = value.bark ?? {};
  const feishu: Partial<FeishuStoredConfig> = value.feishu ?? {};
  return {
    bark: {
      enabled: bark.enabled === true,
      serverUrl:
        typeof bark.serverUrl === "string" && bark.serverUrl.trim()
          ? bark.serverUrl.trim()
          : DEFAULT_NOTIFY_CONFIG.bark.serverUrl,
    },
    feishu: {
      enabled: feishu.enabled === true,
      keywordPrefix:
        typeof feishu.keywordPrefix === "string" ? feishu.keywordPrefix : "",
      signingEnabled: feishu.signingEnabled === true,
    },
  };
}

export interface NotifyConfigView {
  config: NotifyStoredConfig;
  bark: { deviceKey: SecretState };
  feishu: { webhook: SecretState; signingSecret: SecretState };
  version: number;
}

export function getNotifyConfigView(
  db: Database.Database,
  key?: Buffer,
): NotifyConfigView {
  const record = getSetting(db, NOTIFY_SETTING_NAMESPACE);
  return {
    config: getNotifyStoredConfig(db),
    bark: {
      deviceKey: readSecretStateMasked(db, SECRET_NAMESPACES.barkDeviceKey, key),
    },
    feishu: {
      webhook: readSecretStateMasked(db, SECRET_NAMESPACES.feishuWebhook, key),
      signingSecret: readSecretStateMasked(
        db,
        SECRET_NAMESPACES.feishuSigningSecret,
        key,
      ),
    },
    version: record?.version ?? 0,
  };
}

export interface SaveNotifyConfigInput {
  bark?: Partial<BarkStoredConfig> & { deviceKey?: SecretInput };
  feishu?: Partial<FeishuStoredConfig> & {
    webhook?: SecretInput;
    signingSecret?: SecretInput;
  };
}

export function saveNotifyConfig(
  db: Database.Database,
  input: SaveNotifyConfigInput,
  key?: Buffer,
): NotifyConfigView {
  const current = getNotifyStoredConfig(db);
  const next: NotifyStoredConfig = {
    bark: {
      enabled:
        typeof input.bark?.enabled === "boolean"
          ? input.bark.enabled
          : current.bark.enabled,
      serverUrl:
        typeof input.bark?.serverUrl === "string" && input.bark.serverUrl.trim()
          ? input.bark.serverUrl.trim()
          : current.bark.serverUrl,
    },
    feishu: {
      enabled:
        typeof input.feishu?.enabled === "boolean"
          ? input.feishu.enabled
          : current.feishu.enabled,
      keywordPrefix:
        typeof input.feishu?.keywordPrefix === "string"
          ? input.feishu.keywordPrefix
          : current.feishu.keywordPrefix,
      signingEnabled:
        typeof input.feishu?.signingEnabled === "boolean"
          ? input.feishu.signingEnabled
          : current.feishu.signingEnabled,
    },
  };
  setSetting(db, NOTIFY_SETTING_NAMESPACE, next);
  applySecretInput(db, SECRET_NAMESPACES.barkDeviceKey, input.bark?.deviceKey, key);
  applySecretInput(
    db,
    SECRET_NAMESPACES.feishuWebhook,
    input.feishu?.webhook,
    key,
  );
  applySecretInput(
    db,
    SECRET_NAMESPACES.feishuSigningSecret,
    input.feishu?.signingSecret,
    key,
  );
  return getNotifyConfigView(db, key);
}

export interface BarkRuntimeConfig {
  serverUrl: string;
  deviceKey: string;
}

export interface FeishuRuntimeConfig {
  webhookUrl: string;
  signingSecret: string | null;
  keywordPrefix: string | null;
}

export interface NotifyRuntimeConfig {
  bark: BarkRuntimeConfig | null;
  feishu: FeishuRuntimeConfig | null;
  enabledChannels: Array<"bark" | "feishu">;
}

/**
 * 供 worker / 测试使用的运行时配置：
 * 只返回「已启用且凭据已配置」的渠道，凭据在此处解密。
 */
export function getNotifyRuntimeConfig(
  db: Database.Database,
  key?: Buffer,
): NotifyRuntimeConfig {
  const stored = getNotifyStoredConfig(db);
  const barkDeviceKey = getSecret(db, SECRET_NAMESPACES.barkDeviceKey, key);
  const feishuWebhook = getSecret(db, SECRET_NAMESPACES.feishuWebhook, key);
  const feishuSigningSecret = getSecret(
    db,
    SECRET_NAMESPACES.feishuSigningSecret,
    key,
  );

  const bark: BarkRuntimeConfig | null =
    stored.bark.enabled && barkDeviceKey
      ? { serverUrl: stored.bark.serverUrl, deviceKey: barkDeviceKey }
      : null;
  const feishu: FeishuRuntimeConfig | null =
    stored.feishu.enabled && feishuWebhook
      ? {
          webhookUrl: feishuWebhook,
          signingSecret: stored.feishu.signingEnabled
            ? feishuSigningSecret
            : null,
          keywordPrefix: stored.feishu.keywordPrefix || null,
        }
      : null;

  const enabledChannels: Array<"bark" | "feishu"> = [];
  if (bark) enabledChannels.push("bark");
  if (feishu) enabledChannels.push("feishu");

  return { bark, feishu, enabledChannels };
}
