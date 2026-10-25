import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelChannel } from "@/lib/domain/types";

interface ModelChannelRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  timeout_ms: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toModelChannel(row: ModelChannelRow): ModelChannel {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    timeoutMs: row.timeout_ms,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listModelChannels(db: Database.Database): ModelChannel[] {
  const rows = db
    .prepare("SELECT * FROM model_channels ORDER BY created_at ASC, id ASC")
    .all() as ModelChannelRow[];
  return rows.map(toModelChannel);
}

export function getModelChannel(
  db: Database.Database,
  id: string,
): ModelChannel | null {
  const row = db
    .prepare("SELECT * FROM model_channels WHERE id = ?")
    .get(id) as ModelChannelRow | undefined;
  return row ? toModelChannel(row) : null;
}

export function getActiveModelChannel(
  db: Database.Database,
): ModelChannel | null {
  const row = db
    .prepare("SELECT * FROM model_channels WHERE is_active = 1 LIMIT 1")
    .get() as ModelChannelRow | undefined;
  return row ? toModelChannel(row) : null;
}

export interface CreateModelChannelInput {
  name: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  isActive?: boolean;
}

export function createModelChannel(
  db: Database.Database,
  input: CreateModelChannelInput,
  now: Date = new Date(),
): ModelChannel {
  const id = `channel-${randomUUID()}`;
  const nowIso = now.toISOString();
  const timeoutMs = input.timeoutMs ?? 30000;
  const isActive = input.isActive ? 1 : 0;

  if (isActive === 1) {
    db.prepare("UPDATE model_channels SET is_active = 0").run();
  }

  db.prepare(
    `INSERT INTO model_channels (
       id, name, base_url, model, timeout_ms, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.baseUrl.trim(),
    input.model.trim(),
    timeoutMs,
    isActive,
    nowIso,
    nowIso,
  );

  return getModelChannel(db, id)!;
}

export interface UpdateModelChannelInput {
  id: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export function updateModelChannel(
  db: Database.Database,
  input: UpdateModelChannelInput,
  now: Date = new Date(),
): ModelChannel | null {
  const existing = getModelChannel(db, input.id);
  if (!existing) return null;

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl.trim() : existing.baseUrl;
  const model = input.model !== undefined ? input.model.trim() : existing.model;
  const timeoutMs = input.timeoutMs !== undefined ? input.timeoutMs : existing.timeoutMs;
  const nowIso = now.toISOString();

  db.prepare(
    `UPDATE model_channels SET
       name = ?, base_url = ?, model = ?, timeout_ms = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, baseUrl, model, timeoutMs, nowIso, input.id);

  return getModelChannel(db, input.id);
}

export function deleteModelChannel(
  db: Database.Database,
  id: string,
): { deleted: boolean; reason?: string } {
  const channel = getModelChannel(db, id);
  if (!channel) return { deleted: false, reason: "渠道不存在" };
  if (channel.isActive) {
    return { deleted: false, reason: "当前启用的渠道不能直接删除，请先切换至其他渠道" };
  }

  // 检查是否有关联的 Key
  const keyCount = db
    .prepare("SELECT COUNT(*) AS count FROM jev_api_keys WHERE channel_id = ?")
    .get(id) as { count: number };
  if (keyCount.count > 0) {
    return {
      deleted: false,
      reason: `该渠道下还有 ${keyCount.count} 个 API 密钥，请先迁移或删除对应密钥`,
    };
  }

  db.prepare("DELETE FROM model_channels WHERE id = ?").run(id);
  return { deleted: true };
}

export function setActiveModelChannel(
  db: Database.Database,
  id: string,
  now: Date = new Date(),
): ModelChannel | null {
  const channel = getModelChannel(db, id);
  if (!channel) return null;

  const nowIso = now.toISOString();
  db.transaction(() => {
    db.prepare("UPDATE model_channels SET is_active = 0").run();
    db.prepare(
      "UPDATE model_channels SET is_active = 1, updated_at = ? WHERE id = ?",
    ).run(nowIso, id);
  })();

  return getModelChannel(db, id);
}
