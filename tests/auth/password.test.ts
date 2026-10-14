import { describe, expect, it } from "vitest";
import {
  AUTH_SETTING_NAMESPACE,
  ensureAdminCredential,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password";
import { getSetting } from "@/lib/db/repos/settings";
import { createTestDb } from "../helpers/db";

describe("auth/password", () => {
  it("scrypt 哈希可校验且拒绝错误密码", () => {
    const credential = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", credential)).toBe(
      true,
    );
    expect(verifyPassword("wrong", credential)).toBe(false);
  });

  it("相同密码每次生成不同 salt", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
  });

  it("ensureAdminCredential 只保存哈希，不落明文", () => {
    const ctx = createTestDb();
    try {
      const password = "my-admin-password-明文";
      const credential = ensureAdminCredential(ctx.db, {
        adminPassword: password,
      });
      expect(verifyPassword(password, credential)).toBe(true);

      const stored = getSetting(ctx.db, AUTH_SETTING_NAMESPACE);
      expect(stored).not.toBeNull();
      const serialized = JSON.stringify(stored?.value);
      expect(serialized).not.toContain(password);
      expect(serialized).toContain("scrypt");
    } finally {
      ctx.close();
    }
  });

  it("部署密码变更时重新生成哈希", () => {
    const ctx = createTestDb();
    try {
      const first = ensureAdminCredential(ctx.db, {
        adminPassword: "old-password",
      });
      const second = ensureAdminCredential(ctx.db, {
        adminPassword: "new-password",
      });
      expect(second.passwordHash).not.toBe(first.passwordHash);
      expect(verifyPassword("new-password", second)).toBe(true);

      const third = ensureAdminCredential(ctx.db, {
        adminPassword: "new-password",
      });
      expect(third.passwordHash).toBe(second.passwordHash);
    } finally {
      ctx.close();
    }
  });
});
