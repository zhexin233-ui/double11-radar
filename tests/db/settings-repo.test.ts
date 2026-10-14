import { describe, expect, it } from "vitest";
import {
  clearSecret,
  getSecret,
  getSetting,
  hasSecret,
  setSecret,
  setSetting,
} from "@/lib/db/repos/settings";
import { createTestDb, testKey } from "../helpers/db";

describe("db/repos/settings", () => {
  it("写入配置并自增版本", () => {
    const ctx = createTestDb();
    try {
      expect(getSetting(ctx.db, "jev")).toBeNull();
      expect(setSetting(ctx.db, "jev", { model: "a" })).toBe(1);
      expect(setSetting(ctx.db, "jev", { model: "b" })).toBe(2);
      const record = getSetting<{ model: string }>(ctx.db, "jev");
      expect(record?.value.model).toBe("b");
      expect(record?.version).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("凭据加密落库，读取可还原且库内无明文", () => {
    const ctx = createTestDb();
    try {
      const key = testKey();
      const plain = "device-key-abcdef";
      setSecret(ctx.db, "bark.deviceKey", plain, key);

      const raw = ctx.db
        .prepare("SELECT ciphertext FROM secrets WHERE namespace = ?")
        .get("bark.deviceKey") as { ciphertext: string };
      expect(raw.ciphertext).not.toContain(plain);
      expect(raw.ciphertext).toMatch(/^[^:]+:[^:]+:[^:]+$/);

      expect(getSecret(ctx.db, "bark.deviceKey", key)).toBe(plain);
      expect(hasSecret(ctx.db, "bark.deviceKey")).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("替换凭据后读取新值", () => {
    const ctx = createTestDb();
    try {
      const key = testKey();
      setSecret(ctx.db, "feishu.webhook", "https://a", key);
      setSecret(ctx.db, "feishu.webhook", "https://b", key);
      expect(getSecret(ctx.db, "feishu.webhook", key)).toBe("https://b");
    } finally {
      ctx.close();
    }
  });

  it("清除凭据后返回 null", () => {
    const ctx = createTestDb();
    try {
      const key = testKey();
      setSecret(ctx.db, "jev.apiKey", "secret", key);
      expect(clearSecret(ctx.db, "jev.apiKey")).toBe(true);
      expect(clearSecret(ctx.db, "jev.apiKey")).toBe(false);
      expect(getSecret(ctx.db, "jev.apiKey", key)).toBeNull();
      expect(hasSecret(ctx.db, "jev.apiKey")).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("错误密钥无法读取凭据", () => {
    const ctx = createTestDb();
    try {
      setSecret(ctx.db, "jev.apiKey", "secret", testKey(1));
      expect(() => getSecret(ctx.db, "jev.apiKey", testKey(2))).toThrow(
        /解密失败/,
      );
    } finally {
      ctx.close();
    }
  });
});
