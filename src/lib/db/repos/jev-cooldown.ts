import type Database from "better-sqlite3";
import { getSetting, setSetting } from "@/lib/db/repos/settings";

/**
 * 同一 provider 池的共享退避（429 / 529 的 Retry-After）。
 *
 * 多个 Key 可能共享账号级限额，仅靠轮换 Key 无法绕过限流。因此把退避截止时间
 * 持久化在独立的 settings namespace，web 与 worker 共用，任何入口都先检查它。
 */

export const JE_COOLDOWN_NAMESPACE = "jev.cooldown";

export interface JevCooldown {
  until: string | null;
  reason: string | null;
  updatedAt: string | null;
}

const EMPTY: JevCooldown = { until: null, reason: null, updatedAt: null };

export function getJevCooldown(db: Database.Database): JevCooldown {
  const record = getSetting<Partial<JevCooldown>>(db, JE_COOLDOWN_NAMESPACE);
  const value = record?.value ?? {};
  return {
    until: typeof value.until === "string" ? value.until : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

/** 是否处于共享退避窗口内。 */
export function isJevCoolingDown(
  db: Database.Database,
  now: Date = new Date(),
): boolean {
  const { until } = getJevCooldown(db);
  if (!until) return false;
  const deadline = new Date(until).getTime();
  if (Number.isNaN(deadline)) return false;
  return deadline > now.getTime();
}

/**
 * 写入共享退避截止时间；只在比现有截止时间更晚时才延长，避免短暂抖动缩短退避。
 * 已过期的截止时间会被清理。
 */
export function setJevCooldown(
  db: Database.Database,
  until: Date,
  reason: string,
  now: Date = new Date(),
): JevCooldown {
  const current = getJevCooldown(db);
  const currentMs = current.until ? new Date(current.until).getTime() : 0;
  if (Number.isFinite(currentMs) && currentMs > until.getTime()) {
    return current;
  }
  const next: JevCooldown = {
    until: until.toISOString(),
    reason,
    updatedAt: now.toISOString(),
  };
  setSetting(db, JE_COOLDOWN_NAMESPACE, next);
  return next;
}

/** 清理已经过期的退避，返回是否发生变化。 */
export function clearExpiredJevCooldown(
  db: Database.Database,
  now: Date = new Date(),
): void {
  const current = getJevCooldown(db);
  if (!current.until) return;
  const deadline = new Date(current.until).getTime();
  if (Number.isFinite(deadline) && deadline > now.getTime()) return;
  setSetting(db, JE_COOLDOWN_NAMESPACE, EMPTY);
}
