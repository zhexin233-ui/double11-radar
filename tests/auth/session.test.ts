import { describe, expect, it } from "vitest";
import {
  createSession,
  destroySession,
  generateToken,
  getSession,
  hashToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { createTestDb } from "../helpers/db";

const TTL = 7 * 24 * 60 * 60 * 1000;

describe("auth/session", () => {
  it("创建会话后可用 token 校验", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      const now = new Date("2026-01-01T00:00:00.000Z");
      createSession(ctx.db, token, { now });

      const session = getSession(ctx.db, token, { now });
      expect(session).not.toBeNull();
      expect(session?.tokenHash).toBe(hashToken(token));
      expect(session?.expiresAt).toBe(
        new Date(now.getTime() + TTL).toISOString(),
      );
    } finally {
      ctx.close();
    }
  });

  it("非法 token 返回 null", () => {
    const ctx = createTestDb();
    try {
      createSession(ctx.db, generateToken());
      expect(getSession(ctx.db, generateToken())).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("过期会话被清理且返回 null", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      const created = new Date("2026-01-01T00:00:00.000Z");
      createSession(ctx.db, token, { now: created, ttlMs: 1000 });

      const later = new Date(created.getTime() + 5000);
      expect(getSession(ctx.db, token, { now: later })).toBeNull();

      const count = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("滑动续期延长过期时间", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      const created = new Date("2026-01-01T00:00:00.000Z");
      createSession(ctx.db, token, { now: created });

      const later = new Date(created.getTime() + 60_000);
      const session = getSession(ctx.db, token, { now: later });
      expect(session?.lastSeenAt).toBe(later.toISOString());
      expect(new Date(session!.expiresAt).getTime()).toBe(
        later.getTime() + TTL,
      );
    } finally {
      ctx.close();
    }
  });

  it("touch:false 时不更新会话", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      const created = new Date("2026-01-01T00:00:00.000Z");
      createSession(ctx.db, token, { now: created });
      const later = new Date(created.getTime() + 60_000);
      const session = getSession(ctx.db, token, { now: later, touch: false });
      expect(session?.lastSeenAt).toBe(created.toISOString());
    } finally {
      ctx.close();
    }
  });

  it("退出登录删除会话", () => {
    const ctx = createTestDb();
    try {
      const token = generateToken();
      createSession(ctx.db, token);
      expect(destroySession(ctx.db, token)).toBe(true);
      expect(destroySession(ctx.db, token)).toBe(false);
      expect(getSession(ctx.db, token)).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("Cookie 属性按配置决定 Secure", () => {
    expect(sessionCookieOptions({ cookieSecure: false })).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
    });
    expect(sessionCookieOptions({ cookieSecure: true }).secure).toBe(true);
  });
});
