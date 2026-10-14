import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Notification } from "@/lib/domain/types";

/**
 * 通知仓库：一条线报最多一条通知（`UNIQUE(bulletin_id)`），
 * 由事务内 `INSERT OR IGNORE` 保证本地重放不会重复发送。
 */

interface NotificationRow {
  id: string;
  bulletin_id: string;
  payload: string;
  created_at: string;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    bulletinId: row.bulletin_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export function createNotificationIfAbsent(
  db: Database.Database,
  bulletinId: string,
  payload: unknown,
): { notification: Notification; created: boolean } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, bulletin_id, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, bulletinId, JSON.stringify(payload ?? {}), now);
  const existing = getNotificationByBulletin(db, bulletinId);
  if (!existing) {
    throw new Error(`创建通知失败：${bulletinId}`);
  }
  return { notification: existing, created: result.changes === 1 };
}

export function getNotificationByBulletin(
  db: Database.Database,
  bulletinId: string,
): Notification | null {
  const row = db
    .prepare("SELECT * FROM notifications WHERE bulletin_id = ?")
    .get(bulletinId) as NotificationRow | undefined;
  return row ? toNotification(row) : null;
}
