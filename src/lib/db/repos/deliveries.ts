import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Delivery,
  DeliveryStatus,
  NotifyChannel,
} from "@/lib/domain/types";

/**
 * 投递记录仓库。
 *
 * - `UNIQUE(notification_id, channel)` 保证每条通知每渠道只有一条投递；
 * - 领取与重试都按渠道独立，一个渠道成功不影响另一个渠道的重试；
 * - 已 `succeeded` 的记录不会被再次领取（本地重放不重复发送）。
 */

interface DeliveryRow {
  id: string;
  notification_id: string;
  bulletin_id: string;
  channel: string;
  status: string;
  attempts: number;
  lease_until: string | null;
  lease_owner: string | null;
  http_status: number | null;
  biz_code: string | null;
  response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    notificationId: row.notification_id,
    bulletinId: row.bulletin_id,
    channel: row.channel as NotifyChannel,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    leaseOwner: row.lease_owner,
    httpStatus: row.http_status,
    bizCode: row.biz_code,
    response: row.response,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertDeliveryInput {
  notificationId: string;
  bulletinId: string;
  channel: NotifyChannel;
}

export function insertDeliveries(
  db: Database.Database,
  inputs: InsertDeliveryInput[],
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO deliveries (
       id, notification_id, bulletin_id, channel, status, attempts,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
  );
  for (const input of inputs) {
    stmt.run(
      randomUUID(),
      input.notificationId,
      input.bulletinId,
      input.channel,
      now,
      now,
    );
  }
}

export function getDelivery(
  db: Database.Database,
  id: string,
): Delivery | null {
  const row = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as
    | DeliveryRow
    | undefined;
  return row ? toDelivery(row) : null;
}

export function listDeliveriesByNotification(
  db: Database.Database,
  notificationId: string,
): Delivery[] {
  const rows = db
    .prepare(
      "SELECT * FROM deliveries WHERE notification_id = ? ORDER BY channel ASC",
    )
    .all(notificationId) as DeliveryRow[];
  return rows.map(toDelivery);
}

export function listDeliveriesByBulletin(
  db: Database.Database,
  bulletinId: string,
): Delivery[] {
  const rows = db
    .prepare(
      "SELECT * FROM deliveries WHERE bulletin_id = ? ORDER BY channel ASC",
    )
    .all(bulletinId) as DeliveryRow[];
  return rows.map(toDelivery);
}

/** 每个渠道最多自动尝试次数；超过后需人工在网页重试。 */
export const DELIVERY_MAX_ATTEMPTS = 5;

/** 领取一条待发送/待重试投递并加租约；无可用记录返回 null。 */
export function claimDelivery(
  db: Database.Database,
  owner: string,
  leaseMs: number,
  now: Date = new Date(),
): Delivery | null {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const claim = db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM deliveries
         WHERE status = 'pending'
            OR (
              status = 'failed' AND attempts < @maxAttempts
              AND (lease_until IS NULL OR lease_until <= @nowIso)
            )
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({ maxAttempts: DELIVERY_MAX_ATTEMPTS, nowIso }) as { id: string } | undefined;
    if (!candidate) return null;
    const result = db
      .prepare(
        `UPDATE deliveries SET status = 'sending', lease_owner = @owner,
           lease_until = @leaseUntil, updated_at = @nowIso
         WHERE id = @id AND (status = 'pending' OR status = 'failed')`,
      )
      .run({ id: candidate.id, owner, leaseUntil, nowIso });
    if (result.changes !== 1) return null;
    return candidate.id;
  });
  const id = claim.immediate();
  return id ? getDelivery(db, id) : null;
}

export interface MarkDeliveryResultInput {
  id: string;
  status: Extract<DeliveryStatus, "succeeded" | "failed" | "disabled">;
  httpStatus?: number | null;
  bizCode?: string | null;
  response?: string | null;
  error?: string | null;
  /** 可重试失败的下次尝试时间；作为租约字段复用，防止同一轮内立即重复发送。 */
  retryAt?: string | null;
}

export function markDeliveryResult(
  db: Database.Database,
  input: MarkDeliveryResultInput,
): void {
  db.prepare(
    `UPDATE deliveries SET status = @status, attempts = attempts + 1,
       http_status = @httpStatus, biz_code = @bizCode, response = @response,
       error = @error, lease_owner = NULL, lease_until = @retryAt,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id: input.id,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    bizCode: input.bizCode ?? null,
    response: input.response ?? null,
    error: input.error ?? null,
    retryAt: input.retryAt ?? null,
    now: new Date().toISOString(),
  });
}

/** 手动重试：把 failed/disabled/sending 记录放回 pending 并清空租约与下次时间。 */
export function resetDeliveryForRetry(
  db: Database.Database,
  id: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE deliveries SET status = 'pending', lease_owner = NULL,
         lease_until = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed', 'disabled', 'sending')`,
    )
    .run(new Date().toISOString(), id);
  return result.changes === 1;
}

/** 归还超期投递租约。 */
export function reclaimExpiredDeliveryLeases(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const result = db
    .prepare(
      `UPDATE deliveries SET status = 'pending', lease_owner = NULL,
         lease_until = NULL, updated_at = @nowIso
       WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= @nowIso`,
    )
    .run({ nowIso: now.toISOString() });
  return result.changes;
}
