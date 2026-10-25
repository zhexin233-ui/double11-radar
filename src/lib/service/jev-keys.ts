import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JevApiKey } from "@/lib/domain/types";
import {
  createJevKey,
  deleteJevKey as deleteJevKeyRow,
  getJevKey,
  listJevKeys,
  updateJevKey,
} from "@/lib/db/repos/jev-keys";
import {
  clearSecret,
  setSecret,
  setSetting,
} from "@/lib/db/repos/settings";
import {
  JE_SETTING_NAMESPACE,
  getJevConfig,
  getJevConfigView,
  listJevRuntimeKeys,
  readSecretStateMasked,
  type JevConfigView,
  type JevRuntimeKey,
  type SecretInput,
  type SecretState,
} from "@/lib/service/config";

/**
 * Jev 多密钥池的服务层。
 *
 * 职责边界：
 * - 元数据在 `jev_api_keys`，密文在 `secrets`（每个 Key 一个 namespace）；
 * - Key 新增/替换/清除、元数据与密文更新在**同一个 SQLite 事务**内完成；
 * - 替换密钥、手动恢复都会自增 `generation` 并把失败计数清零，从而隔离旧请求的迟到结果；
 * - 网页读取只返回掩码状态（`configured/masked/unreadable`），绝不回传明文。
 */

/** 每个 Key 的密文 namespace；id 一经创建不再改变。 */
export function jevKeySecretNamespace(keyId: string): string {
  return `jev.key.${keyId}`;
}

/**
 * 给 Key 配置打一次版本标记：值不变，仅让 `settings('jev').version` 自增，
 * 使后续 evaluations 记录到「配置已变更」。必须在调用方的事务内执行。
 */
function bumpJevConfigVersion(db: Database.Database): void {
  setSetting(db, JE_SETTING_NAMESPACE, getJevConfig(db));
}

/** Key 列表投影（含掩码状态），供配置页展示。 */
export interface JevKeyView {
  id: string;
  label: string;
  generation: number;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  secretState: SecretState;
}

function toJevKeyView(
  db: Database.Database,
  row: JevApiKey,
  key?: Buffer,
): JevKeyView {
  return {
    id: row.id,
    label: row.label,
    generation: row.generation,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    secretState: readSecretStateMasked(db, row.secretNamespace, key),
  };
}

export function listJevKeyViews(
  db: Database.Database,
  key?: Buffer,
): JevKeyView[] {
  return listJevKeys(db).map((row) => toJevKeyView(db, row, key));
}

export function getJevKeyView(
  db: Database.Database,
  id: string,
  key?: Buffer,
): JevKeyView | null {
  const row = getJevKey(db, id);
  return row ? toJevKeyView(db, row, key) : null;
}

/** `/api/settings/jev` GET 的完整视图：基础配置 + 旧字段掩码 + Key 列表。 */
export interface JevSettingsView extends JevConfigView {
  keys: JevKeyView[];
}

export function getJevSettingsView(
  db: Database.Database,
  key?: Buffer,
): JevSettingsView {
  return { ...getJevConfigView(db, key), keys: listJevKeyViews(db, key) };
}

/** 调度使用的运行时 Key：唯一实现见 `config.listJevRuntimeKeys`。 */
export type { JevRuntimeKey };
export { listJevRuntimeKeys as listRuntimeJevKeys };

export interface AddJevKeyInput {
  label: string;
  apiKey: string;
}

/** 新增一个启用的 Key；元数据与密文在同一事务内写入。 */
export function addJevKey(
  db: Database.Database,
  input: AddJevKeyInput,
  key?: Buffer,
): JevKeyView {
  const label = input.label.trim();
  if (!label) throw new Error("Key 名称不能为空");
  const secret = input.apiKey.trim();
  if (!secret) throw new Error("API 密钥不能为空");

  const id = randomUUID();
  const namespace = jevKeySecretNamespace(id);
  const run = db.transaction(() => {
    createJevKey(db, { id, label, secretNamespace: namespace });
    setSecret(db, namespace, secret, key);
    bumpJevConfigVersion(db);
  });
  run.immediate();

  const view = getJevKeyView(db, id, key);
  if (!view) throw new Error(`创建 Jev Key 失败：${id}`);
  return view;
}

export interface UpdateJevKeyInput {
  label?: string;
  enabled?: boolean;
  /** 三态语义：字符串=替换；`{clear:true}`=清除该 Key 的密文；空/undefined=保留。 */
  apiKey?: SecretInput;
}

/**
 * 修改 label / 启停 / 替换或清除密钥。
 *
 * - 显式 `enabled: true`（手动恢复）：失败计数清零、清除禁用原因、generation +1；
 * - 替换密钥：generation +1、计数清零、清除禁用原因，但**不隐式改变启停状态**；
 * - 清除密钥：同时停用该 Key 并记录原因，不影响池内其它 Key 与历史账本；
 * - 迟到的旧 generation 结果只能写自己的账本，不能改写新状态。
 */
export function updateJevKeySettings(
  db: Database.Database,
  id: string,
  input: UpdateJevKeyInput,
  key?: Buffer,
): JevKeyView | null {
  const existing = getJevKey(db, id);
  if (!existing) return null;

  const run = db.transaction((): void => {
    const patch: Parameters<typeof updateJevKey>[2] = {};
    let secretChanged = false;
    let cleared = false;

    if (typeof input.label === "string") {
      const label = input.label.trim();
      if (!label) throw new Error("Key 名称不能为空");
      patch.label = label;
    }

    if (input.apiKey !== undefined && typeof input.apiKey === "object" && input.apiKey !== null) {
      if (input.apiKey.clear === true) {
        cleared = clearSecret(db, existing.secretNamespace);
        patch.enabled = false;
        patch.disabledReason = "密钥已清除，请替换后再启用";
        patch.consecutiveFailures = 0;
        patch.bumpGeneration = true;
      }
    } else if (typeof input.apiKey === "string" && input.apiKey.trim() !== "") {
      setSecret(db, existing.secretNamespace, input.apiKey.trim(), key);
      secretChanged = true;
      patch.consecutiveFailures = 0;
      patch.disabledReason = null;
      patch.lastError = null;
      patch.bumpGeneration = true;
      if (!cleared) {
        // 替换密钥时不再处于冷却，避免旧限流继续影响新密钥。
        patch.cooldownUntil = null;
      }
    }

    if (typeof input.enabled === "boolean") {
      if (input.enabled && !existing.enabled) {
        // 手动恢复：清零并进入新 generation，旧请求的迟到结果不改写新状态。
        patch.enabled = true;
        patch.consecutiveFailures = 0;
        patch.disabledReason = null;
        patch.lastError = null;
        patch.bumpGeneration = true;
      } else if (!input.enabled && existing.enabled) {
        patch.enabled = false;
        patch.disabledReason = "管理员已手动停用";
      }
    }

    if (Object.keys(patch).length === 0) return;
    updateJevKey(db, id, patch);
    if (secretChanged || cleared) bumpJevConfigVersion(db);
  });
  run.immediate();

  return getJevKeyView(db, id, key);
}

/**
 * 清除单个 Key 的密文并删除元数据行；调用方负责包裹事务。
 * 单 Key 删除与批量删除共用，避免两处 SQL / 步骤顺序漂移。
 */
function deleteJevKeyWithSecret(
  db: Database.Database,
  key: JevApiKey,
): void {
  clearSecret(db, key.secretNamespace);
  deleteJevKeyRow(db, key.id);
}

/** 删除 Key 元数据与其密文；调用账本不级联删除，历史保留 key_id/key_label 快照。 */
export function removeJevKey(
  db: Database.Database,
  id: string,
): boolean {
  const existing = getJevKey(db, id);
  if (!existing) return false;
  const run = db.transaction((): void => {
    deleteJevKeyWithSecret(db, existing);
    bumpJevConfigVersion(db);
  });
  run.immediate();
  return true;
}

/**
 * 删除当前全部禁用（`enabled = false`）的 Key，返回被删除的 id。
 *
 * - 单个 `BEGIN IMMEDIATE` 事务内完成清密文 + 删行，并只 bump 一次配置版本；
 * - 没有禁用 Key 时不写库、不 bump 版本，返回空数组；
 * - 只删除禁用行，启用中的 Key 元数据与密文不受影响；
 * - 调用账本不级联删除，历史保留 `key_id` / `key_label` 快照。
 */
export function removeDisabledJevKeys(db: Database.Database): string[] {
  const run = db.transaction((): string[] => {
    const disabled = listJevKeys(db).filter((key) => !key.enabled);
    if (disabled.length === 0) return [];
    for (const key of disabled) deleteJevKeyWithSecret(db, key);
    bumpJevConfigVersion(db);
    return disabled.map((key) => key.id);
  });
  return run.immediate();
}
