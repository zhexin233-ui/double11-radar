import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Need } from "@/lib/domain/types";

/**
 * 需求仓库。
 *
 * `enabled` 在领域层为 boolean，数据库以 INTEGER 0/1 存储；
 * 每次编辑（名称/备注/启停）都自增 `version`，供判断记录留快照。
 */

interface NeedRow {
  id: string;
  name: string;
  note: string;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function toNeed(row: NeedRow): Need {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listNeeds(db: Database.Database): Need[] {
  const rows = db
    .prepare("SELECT * FROM needs ORDER BY created_at ASC")
    .all() as NeedRow[];
  return rows.map(toNeed);
}

export function listEnabledNeeds(db: Database.Database): Need[] {
  const rows = db
    .prepare("SELECT * FROM needs WHERE enabled = 1 ORDER BY created_at ASC")
    .all() as NeedRow[];
  return rows.map(toNeed);
}

export function getNeed(db: Database.Database, id: string): Need | null {
  const row = db.prepare("SELECT * FROM needs WHERE id = ?").get(id) as
    | NeedRow
    | undefined;
  return row ? toNeed(row) : null;
}

export interface CreateNeedInput {
  name: string;
  note?: string;
  enabled?: boolean;
}

export function createNeed(db: Database.Database, input: CreateNeedInput): Need {
  const now = new Date().toISOString();
  const need: Need = {
    id: randomUUID(),
    name: input.name,
    note: input.note ?? "",
    enabled: input.enabled ?? true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO needs (id, name, note, enabled, version, created_at, updated_at)
     VALUES (@id, @name, @note, @enabled, @version, @createdAt, @updatedAt)`,
  ).run({
    ...need,
    enabled: need.enabled ? 1 : 0,
  });
  return need;
}

export interface UpdateNeedInput {
  name?: string;
  note?: string;
  enabled?: boolean;
}

/** 更新需求内容并自增版本号；需求不存在返回 null。 */
export function updateNeed(
  db: Database.Database,
  id: string,
  input: UpdateNeedInput,
): Need | null {
  const current = getNeed(db, id);
  if (!current) return null;
  const next: Need = {
    ...current,
    name: input.name ?? current.name,
    note: input.note ?? current.note,
    enabled: input.enabled ?? current.enabled,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE needs SET name = @name, note = @note, enabled = @enabled,
       version = @version, updated_at = @updatedAt WHERE id = @id`,
  ).run({ ...next, enabled: next.enabled ? 1 : 0 });
  return next;
}

/** 启停需求（同样自增版本，保证判断快照可追踪）。 */
export function setNeedEnabled(
  db: Database.Database,
  id: string,
  enabled: boolean,
): Need | null {
  return updateNeed(db, id, { enabled });
}

export function deleteNeed(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM needs WHERE id = ?").run(id);
  return result.changes > 0;
}
