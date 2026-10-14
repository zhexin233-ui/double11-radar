import { describe, expect, it } from "vitest";
import { migrate } from "@/lib/db/migrate";
import { createTestDb } from "../helpers/db";

const EXPECTED_TABLES = [
  "schema_migrations",
  "settings",
  "secrets",
  "needs",
  "sessions",
  "login_attempts",
  "channels",
  "channel_catalog",
  "bulletins",
  "jobs",
  "notifications",
  "evaluations",
  "deliveries",
];

describe("db/migrate", () => {
  it("版本 1 建出全部契约表", () => {
    const ctx = createTestDb();
    try {
      const rows = ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = rows.map((row) => row.name);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
    } finally {
      ctx.close();
    }
  });

  it("重复迁移是幂等的", () => {
    const ctx = createTestDb();
    try {
      const second = migrate(ctx.db);
      expect(second.applied).toEqual([]);
      const versions = ctx.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      expect(versions.map((row) => row.version)).toEqual([1]);
    } finally {
      ctx.close();
    }
  });

  it("bulletins 来源身份唯一、price 允许为 NULL", () => {
    const ctx = createTestDb();
    try {
      const insert = ctx.db.prepare(
        `INSERT INTO bulletins
          (id, source, source_ns, source_id, url, title, content, category, price, brand, mall, published_at, payload, content_version, baseline, created_at)
         VALUES (?, 'xianbao', 'feed:test', ?, 'https://example.com/a', '标题', NULL, NULL, NULL, NULL, NULL, NULL, '{}', 'abc', 0, ?)`,
      );
      const now = new Date().toISOString();
      insert.run("b1", "s1", now);
      expect(() => insert.run("b2", "s1", now)).toThrow();
      const row = ctx.db
        .prepare("SELECT price FROM bulletins WHERE id = 'b1'")
        .get() as { price: number | null };
      expect(row.price).toBeNull();
    } finally {
      ctx.close();
    }
  });
});
