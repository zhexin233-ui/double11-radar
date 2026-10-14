import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getSetting, setSetting } from "@/lib/db/repos/settings";
import type { AppEnv } from "@/lib/env";

/**
 * 管理员密码：scrypt 哈希。
 *
 * `ADMIN_PASSWORD` 由部署提供；数据库 `settings('auth')` 只保存哈希参数，
 * 绝不保存明文。启动时调用 `ensureAdminCredential` 生成或核对。
 */

export const AUTH_SETTING_NAMESPACE = "auth";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const CredentialSchema = z.object({
  algo: z.literal("scrypt"),
  salt: z.string().min(1),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  keylen: z.number().int().positive(),
  passwordHash: z.string().min(1),
});

export type ScryptCredential = z.infer<typeof CredentialSchema>;

function derive(password: string, cred: {
  salt: string;
  N: number;
  r: number;
  p: number;
  keylen: number;
}): Buffer {
  return scryptSync(password, Buffer.from(cred.salt, "base64"), cred.keylen, {
    N: cred.N,
    r: cred.r,
    p: cred.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** 生成新的 scrypt 凭据记录。 */
export function hashPassword(password: string): ScryptCredential {
  const salt = randomBytes(16);
  const params = {
    salt: salt.toString("base64"),
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
  };
  const passwordHash = derive(password, params).toString("base64");
  return { algo: "scrypt", ...params, passwordHash };
}

/** 校验明文密码是否匹配凭据记录（常量时间比较）。 */
export function verifyPassword(
  password: string,
  credential: ScryptCredential,
): boolean {
  const expected = Buffer.from(credential.passwordHash, "base64");
  const actual = derive(password, credential);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function parseCredential(value: unknown): ScryptCredential | null {
  const parsed = CredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 确保数据库中存在有效的管理员凭据：
 * - 无记录：用部署密码生成并保存；
 * - 有记录且与部署密码一致：保留；
 * - 有记录但部署密码已变更：重新生成并覆盖。
 */
export function ensureAdminCredential(
  db: Database.Database,
  env: Pick<AppEnv, "adminPassword">,
): ScryptCredential {
  const existing = getSetting(db, AUTH_SETTING_NAMESPACE);
  const stored = existing ? parseCredential(existing.value) : null;
  if (stored && verifyPassword(env.adminPassword, stored)) {
    return stored;
  }
  const credential = hashPassword(env.adminPassword);
  setSetting(db, AUTH_SETTING_NAMESPACE, credential);
  return credential;
}
