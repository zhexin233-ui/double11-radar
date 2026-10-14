import { describe, expect, it } from "vitest";
import { decodeEncryptionKey, loadEnv } from "@/lib/env";

const validKey = Buffer.alloc(32, 3).toString("base64");

function base(overrides: Record<string, string | undefined> = {}) {
  return {
    DATA_DIR: "/tmp/xianbao-data",
    APP_ENCRYPTION_KEY: validKey,
    ADMIN_PASSWORD: "pw",
    ...overrides,
  };
}

describe("lib/env", () => {
  it("解析完整配置并使用默认值", () => {
    const env = loadEnv(base());
    expect(env.dataDir).toBe("/tmp/xianbao-data");
    expect(env.encryptionKey).toHaveLength(32);
    expect(env.cookieSecure).toBe(false);
    expect(env.port).toBe(3000);
    expect(env.xianbaoApiBase).toBe("https://new.xianbao.fun");
  });

  it("缺少 ADMIN_PASSWORD 时抛出中文错误", () => {
    expect(() => loadEnv(base({ ADMIN_PASSWORD: undefined }))).toThrow(
      /ADMIN_PASSWORD/,
    );
  });

  it("缺少 APP_ENCRYPTION_KEY 时抛出中文错误", () => {
    expect(() => loadEnv(base({ APP_ENCRYPTION_KEY: undefined }))).toThrow(
      /APP_ENCRYPTION_KEY/,
    );
  });

  it("密钥解码后不是 32 字节时拒绝", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEnv(base({ APP_ENCRYPTION_KEY: short }))).toThrow(
      /32 字节/,
    );
    expect(() => decodeEncryptionKey("not base64!!!")).toThrow(/base64/);
  });

  it("PORT 非法时拒绝", () => {
    expect(() => loadEnv(base({ PORT: "abc" }))).toThrow(/PORT/);
    expect(() => loadEnv(base({ PORT: "70000" }))).toThrow(/PORT/);
  });

  it("COOKIE_SECURE=true 时开启 Secure", () => {
    expect(loadEnv(base({ COOKIE_SECURE: "true" })).cookieSecure).toBe(true);
  });
});
