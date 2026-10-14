import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  deleteExpiredSessions,
  deleteSession,
  findSession,
  insertSession,
  touchSession,
} from "@/lib/db/repos/sessions";
import { SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/domain/constants";
import type { SessionRecord } from "@/lib/domain/types";
import type { AppEnv } from "@/lib/env";

/**
 * 管理员会话。
 *
 * 明文 token 只存在于 Cookie；数据库只保存 sha256 哈希。
 * 会话采用滑动续期，并在读取时清理已过期记录。
 */

export { SESSION_COOKIE };

export interface SessionOptions {
  ttlMs?: number;
  now?: Date;
}

/** 生成 32 字节随机 token（base64url）。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 计算 token 的 sha256 十六进制摘要。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 创建会话并写入数据库。 */
export function createSession(
  db: Database.Database,
  token: string,
  options: SessionOptions = {},
): SessionRecord {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const record: SessionRecord = {
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    lastSeenAt: now.toISOString(),
  };
  insertSession(db, record);
  return record;
}

/**
 * 读取并校验会话。
 * 已过期则删除并返回 null；默认滑动续期（`touch: false` 可关闭）。
 */
export function getSession(
  db: Database.Database,
  token: string,
  options: SessionOptions & { touch?: boolean } = {},
): SessionRecord | null {
  const now = options.now ?? new Date();
  const tokenHash = hashToken(token);
  const record = findSession(db, tokenHash);
  if (!record) return null;

  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    deleteSession(db, tokenHash);
    return null;
  }

  if (options.touch === false) {
    return record;
  }

  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const lastSeenAt = now.toISOString();
  touchSession(db, tokenHash, expiresAt, lastSeenAt);
  return { ...record, expiresAt, lastSeenAt };
}

/** 退出登录：删除服务端会话记录。 */
export function destroySession(db: Database.Database, token: string): boolean {
  return deleteSession(db, hashToken(token));
}

/** 清理所有过期会话，返回删除数量。 */
export function cleanupExpiredSessions(
  db: Database.Database,
  now: Date = new Date(),
): number {
  return deleteExpiredSessions(db, now.toISOString());
}

/** Cookie 属性。Secure 由部署配置决定，避免局域网 HTTP 首次部署无法登录。 */
export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
}

export function sessionCookieOptions(
  env: Pick<AppEnv, "cookieSecure">,
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.cookieSecure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
