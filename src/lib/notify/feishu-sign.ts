import { createHmac } from "node:crypto";

/**
 * 飞书自定义机器人签名（官方 Method 3）。
 *
 * `stringToSign = timestamp + "\n" + secret`，以它作为 HMAC-SHA256 的 **key**，
 * 对空字符串做摘要后 Base64。时间戳为秒级，与服务端偏差不得超过 3600 秒。
 *
 * 注意：不是对正文签名，也不能把 secret 当 key、timestamp 当 message。
 */
export function genFeishuSign(secret: string, timestampSeconds: number): string {
  const stringToSign = `${timestampSeconds}\n${secret}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}
