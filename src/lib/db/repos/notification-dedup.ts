import type Database from "better-sqlite3";
import type { Bulletin, NotifyChannel } from "@/lib/domain/types";
import { notificationIdentityNamespace } from "@/lib/domain/notification-identity";

/** 必须与创建投递处于同一事务；占位表示已安排投递，不代表发送成功。 */
export function reserveNotificationChannel(
  db: Database.Database,
  bulletin: Pick<Bulletin, "source" | "sourceNs" | "sourceId">,
  channel: NotifyChannel,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO notification_dedup
      (source, identity_ns, source_id, channel, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    bulletin.source,
    notificationIdentityNamespace(bulletin.source, bulletin.sourceNs),
    bulletin.sourceId,
    channel,
    new Date().toISOString(),
  ).changes === 1;
}
