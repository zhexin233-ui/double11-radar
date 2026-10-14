import { describe, expect, it } from "vitest";
import {
  clearLoginFailures,
  isLocked,
  parseCookies,
  readSessionToken,
  recordLoginFailure,
  requireSession,
} from "@/lib/auth/guard";
import { createSession, generateToken } from "@/lib/auth/session";
import { HttpError } from "@/lib/http/json";
import { createTestDb } from "../helpers/db";

describe("auth/guard 登录限速", () => {
  it("连续 5 次失败后锁定 5 分钟", () => {
    const ctx = createTestDb();
    try {
      const ip = "10.0.0.1";
      const now = new Date("2026-01-01T00:00:00.000Z");
      for (let i = 1; i <= 4; i += 1) {
        const result = recordLoginFailure(ctx.db, ip, now);
        expect(result.failures).toBe(i);
        expect(result.lockedUntil).toBeNull();
      }
      const fifth = recordLoginFailure(ctx.db, ip, now);
      expect(fifth.failures).toBe(5);
      expect(fifth.lockedUntil).toBe(
        new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      );
      expect(isLocked(ctx.db, ip, now)).toBe(true);

      const duringLock = new Date(now.getTime() + 60_000);
      expect(isLocked(ctx.db, ip, duringLock)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("锁定期结束后重置计数", () => {
    const ctx = createTestDb();
    try {
      const ip = "10.0.0.2";
      const now = new Date("2026-01-01T00:00:00.000Z");
      for (let i = 0; i < 5; i += 1) recordLoginFailure(ctx.db, ip, now);

      const after = new Date(now.getTime() + 5 * 60 * 1000 + 1000);
      expect(isLocked(ctx.db, ip, after)).toBe(false);

      const next = recordLoginFailure(ctx.db, ip, after);
      expect(next.failures).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("登录成功后清除失败计数", () => {
    const ctx = createTestDb();
    try {
      const ip = "10.0.0.3";
      recordLoginFailure(ctx.db, ip);
      clearLoginFailures(ctx.db, ip);
      expect(isLocked(ctx.db, ip)).toBe(false);
    } finally {
      ctx.close();
    }
  });
});

describe("auth/guard 会话校验", () => {
  it("未登录调用受保护接口抛 401", () => {
    const ctx = createTestDb();
    try {
      const req = new Request("http://localhost/api/needs");
      expect(() => requireSession(ctx.db, req)).toThrowError(HttpError);
      try {
        requireSession(ctx.db, req);
      } catch (error) {
        expect((error as HttpError).status).toBe(401);
      }
    } finally {
      ctx.close();
    }
  });

  it("携带有效 Cookie 时通过校验", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      createSession(ctx.db, token);
      const req = new Request("http://localhost/api/needs", {
        headers: { cookie: `xianbao_session=${token}` },
      });
      const session = requireSession(ctx.db, req);
      expect(session.tokenHash).toBeTruthy();
      expect(readSessionToken(req)).toBe(token);
    } finally {
      ctx.close();
    }
  });

  it("parseCookies 解析多个键值", () => {
    expect(parseCookies("a=1; b=hello%20world; c=")).toEqual({
      a: "1",
      b: "hello world",
      c: "",
    });
    expect(parseCookies(null)).toEqual({});
  });
});
