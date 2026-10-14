import type Database from "better-sqlite3";
import {
  clearSecret,
  getSecret,
  getSetting,
  setSecret,
  setSetting,
} from "@/lib/db/repos/settings";
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
}

export interface JevConfigView {
  config: JevConfig;
  apiKey: SecretState;
  version: number;
}

const DEFAULT_JE_CONFIG: JevConfig = {
  baseUrl: DEFAULT_JE_BASE_URL,
  model: DEFAULT_JE_MODEL,
  timeoutMs: DEFAULT_JE_TIMEOUT_MS,
};

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
  };
}

export function getJevConfigView(
  db: Database.Database,
  key?: Buffer,
): JevConfigView {
  const record = getSetting(db, JE_SETTING_NAMESPACE);
  return {
    config: getJevConfig(db),
    apiKey: readSecretStateMasked(db, SECRET_NAMESPACES.jevApiKey, key),
    version: record?.version ?? 0,
  };
}

export interface SaveJevConfigInput {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
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
  };
  setSetting(db, JE_SETTING_NAMESPACE, next);
  applySecretInput(db, SECRET_NAMESPACES.jevApiKey, input.apiKey, key);
  return getJevConfigView(db, key);
}

/** 供 worker 使用：返回包含明文凭据的运行时配置；密钥缺失时返回 null。 */
export function getJevRuntimeConfig(
  db: Database.Database,
  key?: Buffer,
): (JevConfig & { apiKey: string }) | null {
  const config = getJevConfig(db);
  const apiKey = getSecret(db, SECRET_NAMESPACES.jevApiKey, key);
  if (!apiKey) return null;
  return { ...config, apiKey };
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
