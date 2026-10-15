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

/**
 * 记录页可筛选的非基线状态。
 *
 * 与 {@link BULLETIN_DISPLAY_STATUS_SQL} 的输出一一对应；基线不属于筛选目标
 * （记录页始终排除基线），因此单独由 {@link BulletinDisplayStatus} 扩展。
 */
export type BulletinFilterStatus =
  | "pending"
  | "matched"
  | "uncertain"
  | "failed"
  | "not_matched";

/** 线报在记录页展示的完整状态（含基线）。 */
export type BulletinDisplayStatus = "baseline" | BulletinFilterStatus;

/** 非基线状态的稳定枚举顺序，供 API 校验与前端选项复用。 */
export const BULLETIN_FILTER_STATUSES: readonly BulletinFilterStatus[] = [
  "pending",
  "matched",
  "uncertain",
  "failed",
  "not_matched",
];

/** 校验任意输入是否为可筛选的非基线状态。 */
export function isBulletinFilterStatus(
  value: unknown,
): value is BulletinFilterStatus {
  return (
    typeof value === "string" &&
    (BULLETIN_FILTER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * 记录页状态判定的**唯一 owner**（作用于别名为 `b` 的 bulletins 行）。
 *
 * 优先级严格为：baseline > 任一 matched > 任一 failed > 任一 uncertain > 存在其它判断 > pending。
 * failed 分支在没有 matched 的前提下，额外覆盖「evaluate job 已失败但尚未落 evaluations」：
 * 否则处理失败会被误显示成「没有匹配」。成功重试（`completeJob` 清空 last_error）后
 * 该分支自然回落为 pending / not_matched。
 *
 * 列表过滤（COUNT 与分页）、聚合与详情必须共用这一个表达式，禁止在 TS 里再维护一套优先级。
 */
export const BULLETIN_DISPLAY_STATUS_SQL = `
CASE
  WHEN b.baseline = 1 THEN 'baseline'
  WHEN EXISTS (
    SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id AND e.result = 'matched'
  ) THEN 'matched'
  WHEN EXISTS (
    SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id AND e.result = 'failed'
  ) OR EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.payload_key = 'evaluate:' || b.id
      AND (j.status = 'dead' OR (j.last_error IS NOT NULL AND j.status <> 'succeeded'))
  ) THEN 'failed'
  WHEN EXISTS (
    SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id AND e.result = 'uncertain'
  ) THEN 'uncertain'
  WHEN EXISTS (
    SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id
  ) THEN 'not_matched'
  ELSE 'pending'
END`;

export interface BulletinListQuery {
  limit?: number;
  offset?: number;
  sourceNs?: string;
  baseline?: boolean;
  /** 按展示状态筛选；筛选在 SQL 分页之前执行，items 与 total 使用同一 where。 */
  status?: BulletinFilterStatus;
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
    where.push("b.source_ns = @sourceNs");
    params.sourceNs = query.sourceNs;
  }
  if (query.baseline !== undefined) {
    where.push("b.baseline = @baseline");
    params.baseline = query.baseline ? 1 : 0;
  }
  if (query.status) {
    // 同一 display_status 表达式同时约束 COUNT 与分页查询，避免"先分页再过滤"的漏项。
    where.push(`${BULLETIN_DISPLAY_STATUS_SQL} = @status`);
    params.status = query.status;
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM bulletins b ${clause}`)
    .get(params) as { count: number };
  const rows = db
    .prepare(
      `SELECT b.* FROM bulletins b ${clause}
       ORDER BY COALESCE(b.published_at, b.created_at) DESC, b.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(params) as BulletinRow[];
  return { items: rows.map(toBulletin), total: total.count };
}

/**
 * 读取单条线报的展示状态；不存在返回 null。
 * 详情投影必须调用它，避免 TS 与 SQL 出现两套状态优先级。
 */
export function getBulletinDisplayStatus(
  db: Database.Database,
  id: string,
): BulletinDisplayStatus | null {
  const row = db
    .prepare(`SELECT ${BULLETIN_DISPLAY_STATUS_SQL} AS status FROM bulletins b WHERE b.id = ?`)
    .get(id) as { status: BulletinDisplayStatus } | undefined;
  return row ? row.status : null;
}

export function countBulletins(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM bulletins").get() as {
    count: number;
  };
  return row.count;
}
