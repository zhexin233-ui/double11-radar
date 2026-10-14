import type Database from "better-sqlite3";
import type { SessionRecord } from "@/lib/domain/types";

/**
 * 会话仓库。只处理 token 哈希，不接触明文 token；明文由 auth/session.ts 生成后立即哈希。
 */

interface SessionRow {
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function insertSession(
  db: Database.Database,
  record: SessionRecord,
): void {
  db.prepare(
    `INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at)
     VALUES (@tokenHash, @createdAt, @expiresAt, @lastSeenAt)`,
  ).run(record);
}

export function findSession(
  db: Database.Database,
  tokenHash: string,
): SessionRecord | null {
  const row = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

export function touchSession(
  db: Database.Database,
  tokenHash: string,
  expiresAt: string,
  lastSeenAt: string,
): void {
  db.prepare(
    "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
  ).run(expiresAt, lastSeenAt, tokenHash);
}

export function deleteSession(
  db: Database.Database,
  tokenHash: string,
): boolean {
  const result = db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(tokenHash);
  return result.changes > 0;
}

/** 删除所有已过期会话，返回删除数量。 */
export function deleteExpiredSessions(
  db: Database.Database,
  nowIso: string,
): number {
  const result = db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(nowIso);
  return result.changes;
}
