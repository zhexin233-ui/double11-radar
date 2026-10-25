import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Need } from "@/lib/domain/types";
import { DEFAULT_NEED_GROUP_ID } from "../migrations";

/**
 * 需求仓库。
 *
 * `enabled` 在领域层为 boolean，数据库以 INTEGER 0/1 存储；
 * 每次编辑（名称/备注/启停/分组）都自增 `version`，供判断记录留快照。
 */

interface NeedRow {
  id: string;
  group_id: string;
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
    groupId: row.group_id ?? DEFAULT_NEED_GROUP_ID,
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

export function listNeedsByGroup(
  db: Database.Database,
  groupId: string,
): Need[] {
  const rows = db
    .prepare("SELECT * FROM needs WHERE group_id = ? ORDER BY created_at ASC")
    .all(groupId) as NeedRow[];
  return rows.map(toNeed);
}

/**
 * 服务端分页读取需求清单。
 *
 * 排序追加唯一键 `id`，否则 `created_at` 并列时翻页可能重复/漏项；
 * `items` 与 `total` 在同一个只读事务内读取，保证两者一致。
 */
export function listNeedsPage(
  db: Database.Database,
  query: { limit: number; offset: number; groupId?: string },
): { items: Need[]; total: number } {
  const read = db.transaction(() => {
    if (query.groupId) {
      const total = db
        .prepare("SELECT COUNT(*) AS count FROM needs WHERE group_id = ?")
        .get(query.groupId) as { count: number };
      const rows = db
        .prepare(
          "SELECT * FROM needs WHERE group_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
        )
        .all(query.groupId, query.limit, query.offset) as NeedRow[];
      return { items: rows.map(toNeed), total: total.count };
    }
    const total = db.prepare("SELECT COUNT(*) AS count FROM needs").get() as {
      count: number;
    };
    const rows = db
      .prepare(
        "SELECT * FROM needs ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
      )
      .all(query.limit, query.offset) as NeedRow[];
    return { items: rows.map(toNeed), total: total.count };
  });
  return read();
}

/**
 * 获取所有生效的需求。
 *
 * 双层判定：所属分组已启用 (group.enabled = 1) 且 需求项自身已启用 (need.enabled = 1)。
 */
export function listEnabledNeeds(db: Database.Database): Need[] {
  const rows = db
    .prepare(
      `SELECT n.* FROM needs n
       JOIN need_groups g ON n.group_id = g.id
       WHERE g.enabled = 1 AND n.enabled = 1
       ORDER BY g.order_num ASC, n.created_at ASC`,
    )
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
  groupId?: string;
  name: string;
  note?: string;
  enabled?: boolean;
}

export function createNeed(db: Database.Database, input: CreateNeedInput): Need {
  const now = new Date().toISOString();
  const need: Need = {
    id: randomUUID(),
    groupId: input.groupId ?? DEFAULT_NEED_GROUP_ID,
    name: input.name,
    note: input.note ?? "",
    enabled: input.enabled ?? true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO needs (id, group_id, name, note, enabled, version, created_at, updated_at)
     VALUES (@id, @groupId, @name, @note, @enabled, @version, @createdAt, @updatedAt)`,
  ).run({
    id: need.id,
    groupId: need.groupId,
    name: need.name,
    note: need.note,
    enabled: need.enabled ? 1 : 0,
    version: need.version,
    createdAt: need.createdAt,
    updatedAt: need.updatedAt,
  });
  return need;
}

export interface UpdateNeedInput {
  groupId?: string;
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
    groupId: input.groupId ?? current.groupId,
    name: input.name ?? current.name,
    note: input.note ?? current.note,
    enabled: input.enabled ?? current.enabled,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE needs SET group_id = @groupId, name = @name, note = @note, enabled = @enabled,
       version = @version, updated_at = @updatedAt WHERE id = @id`,
  ).run({
    id: next.id,
    groupId: next.groupId,
    name: next.name,
    note: next.note,
    enabled: next.enabled ? 1 : 0,
    version: next.version,
    updatedAt: next.updatedAt,
  });
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
