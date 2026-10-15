import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JevApiKey } from "@/lib/domain/types";

/**
 * Jev API Key 元数据仓库。
 *
 * 密文仍由 `secrets` 表按 `secret_namespace` 保存（`lib/db/repos/settings.ts`），
 * 本表只存非敏感元数据：label、generation、健康计数与禁用状态。
 *
 * 关键语义：
 * - `generation` 在每次「替换密钥/手动恢复」时自增，用于隔离旧请求的迟到结果；
 * - `enabled = 0` 的 Key 不再参与调度，且**不会**被迟到成功自动启用；
 * - 连续失败达到阈值即原子禁用；成功一次把当前 generation 的计数清零；
 * - 这些健康更新必须与调用账本写在同一事务内（见 `jev-requests.ts`）。
 */

/** 连续三次实际请求失败即自动禁用（用户 2026-10-14 确认的方案）。 */
export const JE_KEY_FAILURE_THRESHOLD = 3;

export const JE_KEY_AUTO_DISABLE_REASON =
  "连续 3 次实际请求失败，已自动禁用；请在页面排查后手动恢复或替换密钥";

interface JevApiKeyRow {
  id: string;
  label: string;
  secret_namespace: string;
  generation: number;
  enabled: number;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_used_at: string | null;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}

function toJevApiKey(row: JevApiKeyRow): JevApiKey {
  return {
    id: row.id,
    label: row.label,
    secretNamespace: row.secret_namespace,
    generation: row.generation,
    enabled: row.enabled === 1,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    cooldownUntil: row.cooldown_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listJevKeys(db: Database.Database): JevApiKey[] {
  const rows = db
    .prepare("SELECT * FROM jev_api_keys ORDER BY created_at ASC, id ASC")
    .all() as JevApiKeyRow[];
  return rows.map(toJevApiKey);
}

export function getJevKey(db: Database.Database, id: string): JevApiKey | null {
  const row = db.prepare("SELECT * FROM jev_api_keys WHERE id = ?").get(id) as
    | JevApiKeyRow
    | undefined;
  return row ? toJevApiKey(row) : null;
}

export function getJevKeyByNamespace(
  db: Database.Database,
  secretNamespace: string,
): JevApiKey | null {
  const row = db
    .prepare("SELECT * FROM jev_api_keys WHERE secret_namespace = ?")
    .get(secretNamespace) as JevApiKeyRow | undefined;
  return row ? toJevApiKey(row) : null;
}

export interface CreateJevKeyInput {
  id?: string;
  label: string;
  secretNamespace: string;
  enabled?: boolean;
}

export function createJevKey(
  db: Database.Database,
  input: CreateJevKeyInput,
): JevApiKey {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jev_api_keys (
       id, label, secret_namespace, generation, enabled, consecutive_failures,
       created_at, updated_at
     ) VALUES (
       @id, @label, @secretNamespace, 1, @enabled, 0, @now, @now
     )`,
  ).run({
    id,
    label: input.label,
    secretNamespace: input.secretNamespace,
    enabled: input.enabled === false ? 0 : 1,
    now,
  });
  const created = getJevKey(db, id);
  if (!created) throw new Error(`创建 Jev Key 失败：${id}`);
  return created;
}

export interface UpdateJevKeyPatch {
  label?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
  lastUsedAt?: string | null;
  cooldownUntil?: string | null;
  /** 替换/恢复时自增，隔离旧 generation 的迟到结果。 */
  bumpGeneration?: boolean;
}

export function updateJevKey(
  db: Database.Database,
  id: string,
  patch: UpdateJevKeyPatch,
): JevApiKey | null {
  const current = getJevKey(db, id);
  if (!current) return null;
  const now = new Date().toISOString();
  const next = {
    id,
    label: patch.label ?? current.label,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    disabledReason:
      patch.disabledReason !== undefined
        ? patch.disabledReason
        : current.disabledReason,
    consecutiveFailures:
      patch.consecutiveFailures ?? current.consecutiveFailures,
    lastError: patch.lastError !== undefined ? patch.lastError : current.lastError,
    lastUsedAt:
      patch.lastUsedAt !== undefined ? patch.lastUsedAt : current.lastUsedAt,
    cooldownUntil:
      patch.cooldownUntil !== undefined
        ? patch.cooldownUntil
        : current.cooldownUntil,
    generation: current.generation + (patch.bumpGeneration ? 1 : 0),
    now,
  };
  db.prepare(
    `UPDATE jev_api_keys SET
       label = @label,
       generation = @generation,
       enabled = @enabled,
       disabled_reason = @disabledReason,
       consecutive_failures = @consecutiveFailures,
       last_error = @lastError,
       last_used_at = @lastUsedAt,
       cooldown_until = @cooldownUntil,
       updated_at = @now
     WHERE id = @id`,
  ).run(next);
  return getJevKey(db, id);
}

/** 删除 Key 元数据；调用账本不级联删除（历史保留 key_id/key_label 快照）。 */
export function deleteJevKey(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM jev_api_keys WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface KeyHealthUpdate {
  keyId: string;
  generation: number;
  now: Date;
}

/**
 * 记录一次**实际请求成功**：把当前 generation 的连续失败计数清零。
 * 仅当 Key 仍启用且 generation 未变时才生效——迟到的成功既不能重新启用
 * 已禁用/人工停用的 Key，也不能抹掉替换后的新 generation 状态。
 */
export function recordJevKeySuccess(db: Database.Database, update: KeyHealthUpdate): void {
  db.prepare(
    `UPDATE jev_api_keys SET consecutive_failures = 0, last_error = NULL,
       updated_at = @now
     WHERE id = @keyId AND generation = @generation AND enabled = 1`,
  ).run({
    keyId: update.keyId,
    generation: update.generation,
    now: update.now.toISOString(),
  });
}

export interface RecordFailureResult {
  /** 更新是否命中当前 generation 且仍启用。 */
  applied: boolean;
  consecutiveFailures: number;
  disabled: boolean;
}

/**
 * 记录一次**实际请求失败**：当前 generation 计数 +1，达到阈值则原子禁用。
 * 仅当 Key 仍启用且 generation 未变时才生效，避免旧请求改写新密钥状态。
 */
export function recordJevKeyFailure(
  db: Database.Database,
  update: KeyHealthUpdate & { error: string },
): RecordFailureResult {
  const key = getJevKey(db, update.keyId);
  if (!key || key.generation !== update.generation || !key.enabled) {
    return {
      applied: false,
      consecutiveFailures: key?.consecutiveFailures ?? 0,
      disabled: key ? !key.enabled : false,
    };
  }
  const failures = key.consecutiveFailures + 1;
  const disabled = failures >= JE_KEY_FAILURE_THRESHOLD;
  db.prepare(
    `UPDATE jev_api_keys SET
       consecutive_failures = @failures,
       last_error = @error,
       enabled = @enabled,
       disabled_reason = @disabledReason,
       updated_at = @now
     WHERE id = @keyId AND generation = @generation`,
  ).run({
    keyId: update.keyId,
    generation: update.generation,
    failures,
    error: update.error,
    enabled: disabled ? 0 : 1,
    disabledReason: disabled ? JE_KEY_AUTO_DISABLE_REASON : key.disabledReason,
    now: update.now.toISOString(),
  });
  return { applied: true, consecutiveFailures: failures, disabled };
}

/** 设置某个 Key 的冷却截止时间（429/529 退避）。 */
export function setJevKeyCooldown(
  db: Database.Database,
  keyId: string,
  cooldownUntil: string | null,
  now: Date = new Date(),
): void {
  db.prepare(
    "UPDATE jev_api_keys SET cooldown_until = ?, updated_at = ? WHERE id = ?",
  ).run(cooldownUntil, now.toISOString(), keyId);
}

export function touchJevKeyUsed(
  db: Database.Database,
  keyId: string,
  now: Date = new Date(),
): void {
  db.prepare("UPDATE jev_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
    now.toISOString(),
    now.toISOString(),
    keyId,
  );
}
