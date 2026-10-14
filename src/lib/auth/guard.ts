import type Database from "better-sqlite3";
import { SESSION_COOKIE, getSession } from "@/lib/auth/session";
import { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES } from "@/lib/domain/constants";
import type { SessionRecord } from "@/lib/domain/types";
import { HttpError } from "@/lib/http/json";

/**
 * 鉴权守卫与登录限速。
 *
 * API 路由必须在服务端调用 `requireSession()`；未登录抛 401，不能仅靠前端跳转。
 */

/** 解析 Cookie 请求头为键值对。 */
export function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const rawValue = part.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(rawValue);
    } catch {
      result[key] = rawValue;
    }
  }
  return result;
}

/** 从请求 Cookie 中读取会话 token。 */
export function readSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies[SESSION_COOKIE] ?? null;
}

/** 校验会话，返回会话记录；未登录或已过期抛 401。 */
export function requireSession(
  db: Database.Database,
  req: Request,
): SessionRecord {
  const token = readSessionToken(req);
  if (!token) {
    throw new HttpError("UNAUTHORIZED", "未登录或会话已失效", 401);
  }
  const session = getSession(db, token);
  if (!session) {
    throw new HttpError("UNAUTHORIZED", "未登录或会话已失效", 401);
  }
  return session;
}

interface AttemptRow {
  ip: string;
  failures: number;
  locked_until: string | null;
  updated_at: string;
}

function getAttempt(
  db: Database.Database,
  ip: string,
): AttemptRow | undefined {
  return db
    .prepare("SELECT * FROM login_attempts WHERE ip = ?")
    .get(ip) as AttemptRow | undefined;
}

/**
 * 该 IP 是否处于登录锁定状态。
 * 锁定期已过时重置计数，使后续尝试重新计数。
 */
export function isLocked(
  db: Database.Database,
  ip: string,
  now: Date = new Date(),
): boolean {
  const row = getAttempt(db, ip);
  if (!row || !row.locked_until) return false;
  if (new Date(row.locked_until).getTime() > now.getTime()) return true;

  db.prepare(
    "UPDATE login_attempts SET failures = 0, locked_until = NULL, updated_at = ? WHERE ip = ?",
  ).run(now.toISOString(), ip);
  return false;
}

/** 记录一次登录失败；达到阈值时锁定。返回当前累计次数与锁定截止时间。 */
export function recordLoginFailure(
  db: Database.Database,
  ip: string,
  now: Date = new Date(),
): { failures: number; lockedUntil: string | null } {
  const row = getAttempt(db, ip);
  const lockExpired =
    row?.locked_until !== null &&
    row?.locked_until !== undefined &&
    new Date(row.locked_until).getTime() <= now.getTime();
  const previousFailures = row && !lockExpired ? row.failures : 0;
  const failures = previousFailures + 1;
  const lockedUntil =
    failures >= LOGIN_MAX_FAILURES
      ? new Date(now.getTime() + LOGIN_LOCK_MS).toISOString()
      : null;
  const updatedAt = now.toISOString();

  db.prepare(
    `INSERT INTO login_attempts (ip, failures, locked_until, updated_at)
     VALUES (@ip, @failures, @lockedUntil, @updatedAt)
     ON CONFLICT(ip) DO UPDATE SET
       failures = excluded.failures,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run({ ip, failures, lockedUntil, updatedAt });

  return { failures, lockedUntil };
}

/** 登录成功后清除该 IP 的失败计数。 */
export function clearLoginFailures(db: Database.Database, ip: string): void {
  db.prepare("DELETE FROM login_attempts WHERE ip = ?").run(ip);
}
