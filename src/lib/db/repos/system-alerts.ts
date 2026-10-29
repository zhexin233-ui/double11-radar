import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NotifyChannel } from "@/lib/domain/types";
import { safeAlertName, type AlertContent } from "@/lib/system-alerts/format";

export const SYSTEM_ALERT_MAX_ATTEMPTS = 5;
export const SYSTEM_ALERT_LEASE_MS = 60_000;
export interface SystemAlert extends AlertContent {
  eventType: "key_auto_disabled" | "key_auto_reenabled";
  id: string;
  keyId: string;
  keyGeneration: number;
  dispatchStatus: "pending" | "dispatched" | "no_channels";
  dispatchedAt: string | null;
}
export interface SystemAlertDelivery {
  id: string;
  alertId: string;
  channel: NotifyChannel;
  status: "pending" | "sending" | "failed" | "succeeded" | "disabled" | "dead";
  attempts: number;
  leaseToken: string | null;
  httpStatus: number | null;
  bizCode: string | null;
  lastError: string | null;
}
const ALERT_COLUMNS = `id, event_type AS eventType, key_id AS keyId, key_generation AS keyGeneration,
 channel_name AS channelName, key_label AS keyLabel, consecutive_failures AS consecutiveFailures,
 occurred_at AS occurredAt, error_category AS errorCategory, http_status AS httpStatus,
 dispatch_status AS dispatchStatus, dispatched_at AS dispatchedAt`;
const DELIVERY_COLUMNS = `id, alert_id AS alertId, channel, status, attempts, lease_token AS leaseToken,
 http_status AS httpStatus, biz_code AS bizCode, last_error AS lastError`;

/** 由真实落账事务调用；也可用于独立内存库的部署验收。 */
export function insertSystemAlert(db: Database.Database, input: AlertContent & { keyId: string; keyGeneration: number }): void {
  db.prepare(`INSERT OR IGNORE INTO system_alerts
    (id,event_type,key_id,key_generation,channel_name,key_label,consecutive_failures,occurred_at,http_status,error_category)
    VALUES (@id,@eventType,@keyId,@keyGeneration,@channelName,@keyLabel,@consecutiveFailures,@occurredAt,@httpStatus,@errorCategory)`)
    .run({ ...input, eventType: input.eventType ?? "key_auto_disabled", id: randomUUID(), channelName: safeAlertName(input.channelName, "未知渠道"), keyLabel: safeAlertName(input.keyLabel, "未命名密钥") });
}
export function getSystemAlert(db: Database.Database, id: string): SystemAlert | null {
  return db.prepare(`SELECT ${ALERT_COLUMNS} FROM system_alerts WHERE id = ?`).get(id) as SystemAlert | undefined ?? null;
}

/** 首次渠道快照与建投递必须一起提交，无渠道也进入不可重复分派的终态。 */
export function dispatchSystemAlerts(db: Database.Database, channels: NotifyChannel[], now = new Date()): void {
  db.transaction(() => {
    const pending = db.prepare("SELECT id FROM system_alerts WHERE dispatch_status = 'pending' ORDER BY occurred_at, id LIMIT 50").all() as { id: string }[];
    for (const alert of pending) {
      for (const channel of new Set(channels)) {
        db.prepare(`INSERT OR IGNORE INTO system_alert_deliveries (id,alert_id,channel,run_at,updated_at)
          VALUES (?,?,?,?,?)`).run(randomUUID(), alert.id, channel, now.toISOString(), now.toISOString());
      }
      db.prepare("UPDATE system_alerts SET dispatch_status = ?, dispatched_at = ? WHERE id = ?")
        .run(channels.length ? "dispatched" : "no_channels", now.toISOString(), alert.id);
    }
  }).immediate();
}

export function reclaimSystemAlertLeases(db: Database.Database, now = new Date()): void {
  db.prepare(`UPDATE system_alert_deliveries SET
    status = CASE WHEN attempts >= @max THEN 'dead' ELSE 'failed' END,
    lease_token = NULL, lease_until = NULL, run_at = @now, updated_at = @now,
    last_error = '发送租约到期，结果未知'
    WHERE status = 'sending' AND lease_until <= @now`)
    .run({ now: now.toISOString(), max: SYSTEM_ALERT_MAX_ATTEMPTS });
}

export function claimSystemAlertDelivery(db: Database.Database, now = new Date()): SystemAlertDelivery | null {
  return db.transaction(() => {
    reclaimSystemAlertLeases(db, now);
    const row = db.prepare(`SELECT id FROM system_alert_deliveries
      WHERE status IN ('pending','failed') AND run_at <= ? AND attempts < ?
      ORDER BY run_at,id LIMIT 1`).get(now.toISOString(), SYSTEM_ALERT_MAX_ATTEMPTS) as { id: string } | undefined;
    if (!row) return null;
    db.prepare(`UPDATE system_alert_deliveries SET status='sending',attempts=attempts+1,
      lease_token=?,lease_until=?,updated_at=? WHERE id=?`)
      .run(randomUUID(), new Date(now.getTime() + SYSTEM_ALERT_LEASE_MS).toISOString(), now.toISOString(), row.id);
    return db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM system_alert_deliveries WHERE id=?`).get(row.id) as SystemAlertDelivery;
  }).immediate();
}

export type AlertDeliveryOutcome = "succeeded" | "retry" | "permanent" | "channel_disabled";
const OUTCOME_ERRORS = {
  succeeded: null,
  retry: "渠道发送暂时失败，请检查通知服务与网络",
  permanent: "渠道配置或业务返回错误，已停止自动重试",
  channel_disabled: "该渠道已停用或未完成配置，已停止自动重试",
};
/** 不接受原始错误/响应。token 和有效租约同时守卫迟到结果。 */
export function finishSystemAlertDelivery(db: Database.Database, delivery: SystemAlertDelivery, outcome: AlertDeliveryOutcome,
  now = new Date(), httpStatus: number | null = null, bizCode: string | null = null): boolean {
  const status = outcome === "succeeded" ? "succeeded" : outcome === "retry"
    ? delivery.attempts >= SYSTEM_ALERT_MAX_ATTEMPTS ? "dead" : "failed" : "disabled";
  return db.prepare(`UPDATE system_alert_deliveries SET status=@status,lease_until=NULL,lease_token=NULL,
    run_at=@runAt,updated_at=@now,http_status=@httpStatus,biz_code=@bizCode,last_error=@error
    WHERE id=@id AND status='sending' AND lease_token=@token AND lease_until > @now`)
    .run({ id: delivery.id, token: delivery.leaseToken, status, now: now.toISOString(),
      runAt: new Date(now.getTime() + Math.min(10 * 2 ** (delivery.attempts - 1), 300) * 1000).toISOString(),
      httpStatus, bizCode: bizCode && /^-?\d{1,10}$/.test(bizCode) ? bizCode : null, error: OUTCOME_ERRORS[outcome] }).changes === 1;
}

export function listRecentSystemAlerts(db: Database.Database): Array<SystemAlert & { deliveries: SystemAlertDelivery[] }> {
  const alerts = db.prepare(`SELECT ${ALERT_COLUMNS} FROM system_alerts ORDER BY occurred_at DESC,id DESC LIMIT 10`).all() as SystemAlert[];
  return alerts.map((alert) => ({ ...alert, deliveries: db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM system_alert_deliveries WHERE alert_id=? ORDER BY channel`).all(alert.id) as SystemAlertDelivery[] }));
}
