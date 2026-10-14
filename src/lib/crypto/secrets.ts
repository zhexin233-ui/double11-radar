import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * 凭据加密：AES-256-GCM。
 *
 * 存储格式为 `iv:tag:ciphertext`，三段均为 base64。
 * 密钥必须是 32 字节（来自 APP_ENCRYPTION_KEY）。
 */

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error("加密密钥必须是 32 字节的 Buffer");
  }
}

/** 加密明文，返回 `iv:tag:ciphertext` 形式的 base64 字符串。 */
export function encryptSecret(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * 解密密文。密钥错误或密文被篡改时认证标签校验失败并抛出中文错误。
 */
export function decryptSecret(payload: string, key: Buffer): string {
  assertKey(key);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("密文格式不合法，应为 iv:tag:ciphertext");
  }
  const [ivB64, tagB64, dataB64] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let data: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    tag = Buffer.from(tagB64, "base64");
    data = Buffer.from(dataB64, "base64");
  } catch {
    throw new Error("密文不是合法的 base64 编码");
  }
  if (iv.length !== IV_LENGTH || tag.length !== 16) {
    throw new Error("密文结构不合法（iv 或 tag 长度错误）");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new Error("解密失败：密钥不匹配或密文已被篡改");
  }
}

/** 常量时间比较两个字符串，用于校验值比较。 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
