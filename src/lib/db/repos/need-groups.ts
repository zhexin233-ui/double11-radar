import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NeedGroup } from "@/lib/domain/types";

interface NeedGroupRow {
  id: string;
  name: string;
  enabled: number;
  order_num: number;
  created_at: string;
  updated_at: string;
}

function toNeedGroup(row: NeedGroupRow): NeedGroup {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    orderNum: row.order_num,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listNeedGroups(db: Database.Database): NeedGroup[] {
  const rows = db
    .prepare("SELECT * FROM need_groups ORDER BY order_num ASC, created_at ASC")
    .all() as NeedGroupRow[];
  return rows.map(toNeedGroup);
}

export function getNeedGroup(
  db: Database.Database,
  id: string,
): NeedGroup | null {
  const row = db
    .prepare("SELECT * FROM need_groups WHERE id = ?")
    .get(id) as NeedGroupRow | undefined;
  return row ? toNeedGroup(row) : null;
}

export interface CreateNeedGroupInput {
  name: string;
  enabled?: boolean;
  orderNum?: number;
}

export function createNeedGroup(
  db: Database.Database,
  input: CreateNeedGroupInput,
): NeedGroup {
  const now = new Date().toISOString();
  const group: NeedGroup = {
    id: randomUUID(),
    name: input.name,
    enabled: input.enabled ?? true,
    orderNum: input.orderNum ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO need_groups (id, name, enabled, order_num, created_at, updated_at)
     VALUES (@id, @name, @enabled, @orderNum, @createdAt, @updatedAt)`,
  ).run({
    id: group.id,
    name: group.name,
    enabled: group.enabled ? 1 : 0,
    orderNum: group.orderNum,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  });
  return group;
}

export interface UpdateNeedGroupInput {
  name?: string;
  enabled?: boolean;
  orderNum?: number;
}

export function updateNeedGroup(
  db: Database.Database,
  id: string,
  input: UpdateNeedGroupInput,
): NeedGroup | null {
  const existing = getNeedGroup(db, id);
  if (!existing) return null;

  const name = input.name !== undefined ? input.name : existing.name;
  const enabled =
    input.enabled !== undefined ? input.enabled : existing.enabled;
  const orderNum =
    input.orderNum !== undefined ? input.orderNum : existing.orderNum;
  const updatedAt = new Date().toISOString();

  db.prepare(
    `UPDATE need_groups
     SET name = @name, enabled = @enabled, order_num = @orderNum, updated_at = @updatedAt
     WHERE id = @id`,
  ).run({
    id,
    name,
    enabled: enabled ? 1 : 0,
    orderNum,
    updatedAt,
  });

  return {
    ...existing,
    name,
    enabled,
    orderNum,
    updatedAt,
  };
}

/**
 * 级联删除分组及该组下的所有需求。
 * 使用事务保证原子性。
 */
export function deleteNeedGroup(db: Database.Database, id: string): boolean {
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM needs WHERE group_id = ?").run(id);
    const result = db.prepare("DELETE FROM need_groups WHERE id = ?").run(id);
    return result.changes > 0;
  });
  return remove();
}
