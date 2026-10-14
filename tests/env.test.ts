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

  it("PORT 不属于应用配置：任意值都不影响 loadEnv（只由 compose 端口映射使用）", () => {
    const env = loadEnv(base({ PORT: "abc" }));
    expect(env.dataDir).toBe("/tmp/xianbao-data");
    expect(Object.keys(env)).not.toContain("port");
    // 容器内固定监听 3000，宿主机发布端口由 compose 的 ${PORT:-3000}:3000 决定
    expect(loadEnv(base({ PORT: "70000" })).xianbaoApiBase).toBe(
      "https://new.xianbao.fun",
    );
  });

  it("COOKIE_SECURE=true 时开启 Secure", () => {
    expect(loadEnv(base({ COOKIE_SECURE: "true" })).cookieSecure).toBe(true);
  });
});
