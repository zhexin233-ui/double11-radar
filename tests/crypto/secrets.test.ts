import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { testKey } from "../helpers/db";

describe("crypto/secrets", () => {
  it("加密后可原样解密", () => {
    const key = testKey();
    const plain = "sk-test-中文-key-123";
    const payload = encryptSecret(plain, key);
    expect(payload.split(":")).toHaveLength(3);
    expect(decryptSecret(payload, key)).toBe(plain);
  });

  it("每次加密使用不同 IV，密文不重复", () => {
    const key = testKey();
    const a = encryptSecret("same-value", key);
    const b = encryptSecret("same-value", key);
    expect(a).not.toBe(b);
  });

  it("错误密钥解密失败", () => {
    const payload = encryptSecret("secret", testKey(1));
    expect(() => decryptSecret(payload, testKey(2))).toThrow(/解密失败/);
  });

  it("密文被篡改时解密失败", () => {
    const key = testKey();
    const payload = encryptSecret("secret", key);
    const [iv, tag, data] = payload.split(":");
    const tampered = [iv, tag, Buffer.from("tampered!!").toString("base64")].join(
      ":",
    );
    expect(data).toBeTruthy();
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("密文格式不合法时抛出中文错误", () => {
    expect(() => decryptSecret("not-a-valid-payload", testKey())).toThrow(
      /密文格式不合法/,
    );
  });

  it("密钥长度不是 32 字节时拒绝", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16))).toThrow(/32 字节/);
  });
});
