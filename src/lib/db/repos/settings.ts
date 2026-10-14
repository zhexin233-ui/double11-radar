import type Database from "better-sqlite3";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { loadEnv } from "@/lib/env";

/**
 * 非敏感配置与加密凭据仓库。
 *
 * - `settings`：JSON 值 + 自增 version（配置版本随每次写入递增）。
 * - `secrets`：AES-256-GCM 密文，namespace 见契约
 *   （`jev.apiKey`、`bark.deviceKey`、`feishu.webhook`、`feishu.signingSecret`）。
 */

export interface SettingRecord<T = unknown> {
  namespace: string;
  value: T;
  version: number;
  updatedAt: string;
}

interface SettingRow {
  namespace: string;
  value: string;
  version: number;
  updated_at: string;
}

export function getSetting<T = unknown>(
  db: Database.Database,
  namespace: string,
): SettingRecord<T> | null {
  const row = db
    .prepare("SELECT * FROM settings WHERE namespace = ?")
    .get(namespace) as SettingRow | undefined;
  if (!row) return null;
  return {
    namespace: row.namespace,
    value: JSON.parse(row.value) as T,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** 写入配置并自增版本号，返回新版本号。 */
export function setSetting(
  db: Database.Database,
  namespace: string,
  value: unknown,
): number {
  const existing = getSetting(db, namespace);
  const nextVersion = (existing?.version ?? 0) + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (namespace, value, version, updated_at)
     VALUES (@namespace, @value, @version, @updated_at)
     ON CONFLICT(namespace) DO UPDATE SET
       value = excluded.value,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  ).run({
    namespace,
    value: JSON.stringify(value),
    version: nextVersion,
    updated_at: now,
  });
  return nextVersion;
}

function defaultKey(): Buffer {
  return loadEnv().encryptionKey;
}

/** 解密读取凭据原文；不存在返回 null。 */
export function getSecret(
  db: Database.Database,
  namespace: string,
  key: Buffer = defaultKey(),
): string | null {
  const row = db
    .prepare("SELECT ciphertext FROM secrets WHERE namespace = ?")
    .get(namespace) as { ciphertext: string } | undefined;
  if (!row) return null;
  return decryptSecret(row.ciphertext, key);
}

/** 写入/替换凭据。 */
export function setSecret(
  db: Database.Database,
  namespace: string,
  value: string,
  key: Buffer = defaultKey(),
): void {
  const ciphertext = encryptSecret(value, key);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO secrets (namespace, ciphertext, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(namespace) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       updated_at = excluded.updated_at`,
  ).run(namespace, ciphertext, now);
}

/** 清除凭据，返回是否删除了一行。 */
export function clearSecret(db: Database.Database, namespace: string): boolean {
  const result = db
    .prepare("DELETE FROM secrets WHERE namespace = ?")
    .run(namespace);
  return result.changes > 0;
}

/** 凭据是否已配置（不暴露原文）。 */
export function hasSecret(db: Database.Database, namespace: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM secrets WHERE namespace = ?")
    .get(namespace) as { present: number } | undefined;
  return row !== undefined;
}
