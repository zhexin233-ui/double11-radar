import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Bulletin, NormalizedBulletin } from "@/lib/domain/types";

/**
 * 线报仓库。
 *
 * 去重键为 `(source, source_ns, source_id)`，保证不同频道/编号空间不互相合并。
 * 基线保护：始终 `INSERT OR IGNORE`，从不 UPDATE 既有行的 `baseline` 或状态，
 * 因此建立新频道基线不会降级、取消其它频道已入队/已判断/已投递的记录。
 */

interface BulletinRow {
  id: string;
  source: string;
  source_ns: string;
  source_id: string;
  url: string;
  title: string;
  content: string | null;
  category: string | null;
  price: number | null;
  brand: string | null;
  mall: string | null;
  published_at: string | null;
  payload: string;
  content_version: string;
  baseline: number;
  created_at: string;
}

function toBulletin(row: BulletinRow): Bulletin {
  return {
    id: row.id,
    source: row.source,
    sourceNs: row.source_ns,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    content: row.content,
    category: row.category,
    price: row.price,
    brand: row.brand,
    mall: row.mall,
    publishedAt: row.published_at,
    payload: row.payload,
    contentVersion: row.content_version,
    baseline: row.baseline === 1,
    createdAt: row.created_at,
  };
}

export interface InsertBulletinResult {
  inserted: boolean;
  id: string;
}

/**
 * 插入线报；已存在（同 source/ns/id）时不做任何修改。
 * 只有本次真正新插入且 `baseline = true` 的行才带基线标记。
 */
export function insertBulletinIfAbsent(
  db: Database.Database,
  bulletin: NormalizedBulletin,
  options: { baseline: boolean },
): InsertBulletinResult {
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO bulletins (
         id, source, source_ns, source_id, url, title, content, category, price,
         brand, mall, published_at, payload, content_version, baseline, created_at
       ) VALUES (
         @id, @source, @sourceNs, @sourceId, @url, @title, @content, @category, @price,
         @brand, @mall, @publishedAt, @payload, @contentVersion, @baseline, @createdAt
       )`,
    )
    .run({
      id,
      ...bulletin,
      baseline: options.baseline ? 1 : 0,
      createdAt: now,
    });

  if (result.changes === 1) {
    return { inserted: true, id };
  }
  const existing = db
    .prepare(
      "SELECT id FROM bulletins WHERE source = ? AND source_ns = ? AND source_id = ?",
    )
    .get(bulletin.source, bulletin.sourceNs, bulletin.sourceId) as
    | { id: string }
    | undefined;
  return { inserted: false, id: existing?.id ?? id };
}

/** 同一来源记录是否已在其它编号空间被处理（用于跨频道基线保护的回归验证）。 */
export function hasActiveRecordInOtherNs(
  db: Database.Database,
  source: string,
  sourceId: string,
  sourceNs: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM bulletins b
       WHERE b.source = @source AND b.source_id = @sourceId AND b.source_ns <> @sourceNs
         AND (
           b.baseline = 0
           OR EXISTS (SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id)
           OR EXISTS (SELECT 1 FROM jobs j WHERE j.payload_key = 'evaluate:' || b.id)
           OR EXISTS (SELECT 1 FROM deliveries d WHERE d.bulletin_id = b.id)
         )
       LIMIT 1`,
    )
    .get({ source, sourceId, sourceNs }) as { present: number } | undefined;
  return row !== undefined;
}

export function getBulletin(
  db: Database.Database,
  id: string,
): Bulletin | null {
  const row = db.prepare("SELECT * FROM bulletins WHERE id = ?").get(id) as
    | BulletinRow
    | undefined;
  return row ? toBulletin(row) : null;
}

export interface BulletinListQuery {
  limit?: number;
  offset?: number;
  sourceNs?: string;
  baseline?: boolean;
}

export function listBulletins(
  db: Database.Database,
  query: BulletinListQuery = {},
): { items: Bulletin[]; total: number } {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (query.sourceNs) {
    where.push("source_ns = @sourceNs");
    params.sourceNs = query.sourceNs;
  }
  if (query.baseline !== undefined) {
    where.push("baseline = @baseline");
    params.baseline = query.baseline ? 1 : 0;
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM bulletins ${clause}`)
    .get(params) as { count: number };
  const rows = db
    .prepare(
      `SELECT * FROM bulletins ${clause}
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(params) as BulletinRow[];
  return { items: rows.map(toBulletin), total: total.count };
}

export function countBulletins(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM bulletins").get() as {
    count: number;
  };
  return row.count;
}
