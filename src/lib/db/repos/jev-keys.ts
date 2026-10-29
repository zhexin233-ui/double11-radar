import { insertSystemAlert } from "@/lib/db/repos/system-alerts";
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

/** 连续十次实际请求失败即自动禁用（用户 2026-10-27 调整）。 */
export const JE_KEY_FAILURE_THRESHOLD = 10;

export const JE_KEY_AUTO_DISABLE_REASON =
  `连续 ${JE_KEY_FAILURE_THRESHOLD} 次实际请求失败，已自动禁用`;

interface JevApiKeyRow {
  id: string;
  channel_id: string | null;
  base_url: string;
  label: string;
  secret_namespace: string;
  generation: number;
  enabled: number;
  auto_reenable_enabled: number;
  auto_reenable_minutes: number;
  auto_disabled_at: string | null;
  auto_reenable_at: string | null;
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
    channelId: row.channel_id,
    baseUrl: row.base_url,
    label: row.label,
    secretNamespace: row.secret_namespace,
    generation: row.generation,
    enabled: row.enabled === 1,
    autoReenableEnabled: row.auto_reenable_enabled === 1,
    autoReenableMinutes: row.auto_reenable_minutes,
    autoDisabledAt: row.auto_disabled_at,
    autoReenableAt: row.auto_reenable_at,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    cooldownUntil: row.cooldown_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listJevKeys(
  db: Database.Database,
  filter?: { channelId?: string; baseUrl?: string },
): JevApiKey[] {
  if (filter?.channelId) {
    const rows = db
      .prepare(
        "SELECT * FROM jev_api_keys WHERE channel_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(filter.channelId) as JevApiKeyRow[];
    return rows.map(toJevApiKey);
  }
  if (filter?.baseUrl) {
    const rows = db
      .prepare(
        "SELECT * FROM jev_api_keys WHERE base_url = ? ORDER BY created_at ASC, id ASC",
      )
      .all(filter.baseUrl) as JevApiKeyRow[];
    return rows.map(toJevApiKey);
  }
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
  channelId?: string | null;
  baseUrl?: string;
  label: string;
  secretNamespace: string;
  enabled?: boolean;
  autoReenableEnabled?: boolean;
  autoReenableMinutes?: number;
}

export function createJevKey(
  db: Database.Database,
  input: CreateJevKeyInput,
): JevApiKey {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jev_api_keys (
       id, channel_id, base_url, label, secret_namespace, generation, enabled, consecutive_failures,
       auto_reenable_enabled, auto_reenable_minutes, created_at, updated_at
     ) VALUES (
       @id, @channelId, @baseUrl, @label, @secretNamespace, 1, @enabled, 0, @autoReenableEnabled, @autoReenableMinutes, @now, @now
     )`,
  ).run({
    id,
    channelId: input.channelId ?? null,
    baseUrl: input.baseUrl ?? "",
    label: input.label,
    secretNamespace: input.secretNamespace,
    enabled: input.enabled === false ? 0 : 1,
    autoReenableEnabled: input.autoReenableEnabled ? 1 : 0,
    autoReenableMinutes: input.autoReenableMinutes ?? 5,
    now,
  });
  const created = getJevKey(db, id);
  if (!created) throw new Error(`创建 Jev Key 失败：${id}`);
  return created;
}

export interface UpdateJevKeyPatch {
  channelId?: string | null;
  baseUrl?: string;
  label?: string;
  enabled?: boolean;
  autoReenableEnabled?: boolean;
  autoReenableMinutes?: number;
  autoDisabledAt?: string | null;
  autoReenableAt?: string | null;
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
    channelId: patch.channelId !== undefined ? patch.channelId : current.channelId,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : current.baseUrl,
    label: patch.label ?? current.label,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    autoReenableEnabled: (patch.autoReenableEnabled ?? current.autoReenableEnabled) ? 1 : 0,
    autoReenableMinutes: patch.autoReenableMinutes ?? current.autoReenableMinutes,
    autoDisabledAt: patch.autoDisabledAt !== undefined ? patch.autoDisabledAt : current.autoDisabledAt,
    autoReenableAt: patch.autoReenableAt !== undefined ? patch.autoReenableAt : current.autoReenableAt,
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
       channel_id = @channelId,
       base_url = @baseUrl,
       label = @label,
       generation = @generation,
       enabled = @enabled,
       auto_reenable_enabled = @autoReenableEnabled,
       auto_reenable_minutes = @autoReenableMinutes,
       auto_disabled_at = @autoDisabledAt,
       auto_reenable_at = @autoReenableAt,
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
       auto_disabled_at = @autoDisabledAt,
       auto_reenable_at = @autoReenableAt,
       updated_at = @now
     WHERE id = @keyId AND generation = @generation`,
  ).run({
    keyId: update.keyId,
    generation: update.generation,
    failures,
    error: update.error,
    enabled: disabled ? 0 : 1,
    disabledReason: disabled ? JE_KEY_AUTO_DISABLE_REASON : key.disabledReason,
    autoDisabledAt: disabled ? update.now.toISOString() : key.autoDisabledAt,
    autoReenableAt: disabled && key.autoReenableEnabled
      ? new Date(update.now.getTime() + key.autoReenableMinutes * 60_000).toISOString() : null,
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
  generation?: number,
): void {
  db.prepare(
    "UPDATE jev_api_keys SET cooldown_until = ?, updated_at = ? WHERE id = ? AND (? IS NULL OR generation = ?)",
  ).run(cooldownUntil, now.toISOString(), keyId, generation ?? null, generation ?? null);
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

/** 到期恢复与安全通知快照同事务；不调用网络、不清除限流冷却。 */
export function reenableDueJevKeys(db: Database.Database, now = new Date()): number {
  return db.transaction(() => {
    const due = db.prepare(`SELECT * FROM jev_api_keys
      WHERE enabled = 0 AND auto_reenable_enabled = 1 AND auto_disabled_at IS NOT NULL
        AND auto_reenable_at IS NOT NULL AND auto_reenable_at <= ?
        AND EXISTS (SELECT 1 FROM secrets WHERE namespace = jev_api_keys.secret_namespace)`)
      .all(now.toISOString()) as JevApiKeyRow[];
    for (const row of due) {
      const changed = db.prepare(`UPDATE jev_api_keys SET enabled = 1, generation = generation + 1,
        consecutive_failures = 0, disabled_reason = NULL, last_error = NULL,
        auto_disabled_at = NULL, auto_reenable_at = NULL, updated_at = @now
        WHERE id = @id AND generation = @generation AND enabled = 0
          AND auto_reenable_enabled = 1 AND auto_disabled_at IS NOT NULL AND auto_reenable_at <= @now`)
        .run({ id: row.id, generation: row.generation, now: now.toISOString() }).changes;
      if (!changed) continue;
      const channel = row.channel_id
        ? db.prepare("SELECT name FROM model_channels WHERE id = ?").get(row.channel_id) as { name: string } | undefined
        : undefined;
      insertSystemAlert(db, {
        eventType: "key_auto_reenabled", keyId: row.id, keyGeneration: row.generation + 1,
        channelName: channel?.name ?? "未知渠道", keyLabel: row.label,
        consecutiveFailures: row.consecutive_failures, occurredAt: now.toISOString(),
        httpStatus: null, errorCategory: null,
      });
    }
    return due.length;
  }).immediate();
}
