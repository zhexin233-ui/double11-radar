import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db/migrate";
import {
  LEGACY_JEV_KEY_ID,
  LEGACY_JEV_KEY_NAMESPACE,
  LEGACY_JEV_SECRET_NAMESPACE,
  migrations,
} from "@/lib/db/migrations";
import { getDb, closeDb } from "@/lib/db/client";
import {
  getSecret,
  hasSecret,
  setSecret,
} from "@/lib/db/repos/settings";
import { getJevKey, listJevKeys } from "@/lib/db/repos/jev-keys";
import { createTestDb, testKey } from "../helpers/db";

const EXPECTED_TABLES = [
  "schema_migrations",
  "settings",
  "secrets",
  "need_groups",
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
  "jev_api_keys",
  "jev_requests",
  "evaluation_runs",
  "evaluation_batch_parts",
  "bulletin_processing",
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
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
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

  it("V2 把旧单密钥密文原样迁移到兼容 Key 且只创建一次（AC2）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-v2-"));
    const dbPath = path.join(dir, "test.db");
    const key = testKey();
    try {
      // 仅应用 V1，模拟旧版本数据库。
      const db = getDb(dbPath);
      migrate(db, [migrations[0]]);
      setSecret(db, LEGACY_JEV_SECRET_NAMESPACE, "sk-legacy-secret", key);

      // 升级到 V2/V3/V4/V5/V6：数据迁移在同一事务内执行。
      expect(migrate(db).applied).toEqual([2, 3, 4, 5, 6]);
      expect(listJevKeys(db)).toHaveLength(1);
      expect(getJevKey(db, LEGACY_JEV_KEY_ID)?.enabled).toBe(true);
      expect(getSecret(db, LEGACY_JEV_KEY_NAMESPACE, key)).toBe("sk-legacy-secret");
      // 旧 namespace 已被清除，且不解密、不重加密。
      expect(hasSecret(db, LEGACY_JEV_SECRET_NAMESPACE)).toBe(false);

      // 验证 V5 自动创建了默认分组
      const defaultGroup = db.prepare("SELECT * FROM need_groups WHERE id = 'default'").get() as {
        id: string;
        name: string;
        enabled: number;
      };
      expect(defaultGroup).toBeDefined();
      expect(defaultGroup.name).toBe("默认分组");
      expect(defaultGroup.enabled).toBe(1);

      // 再次迁移（模拟另一个进程启动）不重复创建、不改变密文。
      expect(migrate(db).applied).toEqual([]);
      expect(listJevKeys(db)).toHaveLength(1);
      expect(getSecret(db, LEGACY_JEV_KEY_NAMESPACE, key)).toBe("sk-legacy-secret");

      // 第二个连接（模拟 web/worker 并发启动）读到已应用版本，V2 不重复执行。
      const second = new Database(dbPath);
      second.pragma("busy_timeout = 5000");
      expect(migrate(second).applied).toEqual([]);
      expect(listJevKeys(second)).toHaveLength(1);
      second.close();
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无旧密钥的新库不创建空兼容 Key", () => {
    const ctx = createTestDb();
    try {
      expect(listJevKeys(ctx.db)).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("V3 新增三模式表与账本关联列，重复迁移不重复加列（AC2/AC11）", () => {
    const ctx = createTestDb();
    try {
      const columns = ctx.db
        .prepare("PRAGMA table_info(jev_requests)")
        .all() as Array<{ name: string }>;
      const names = columns.map((row) => row.name);
      expect(names).toContain("evaluation_run_id");
      expect(names).toContain("batch_part_id");

      const processingColumns = ctx.db
        .prepare("PRAGMA table_info(bulletin_processing)")
        .all() as Array<{ name: string }>;
      expect(processingColumns.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "bulletin_id",
          "run_id",
          "batch_part_id",
          "stage",
          "screening_source",
          "matched_rule_index",
        ]),
      );

      // 重复迁移为幂等：不会因二次 ALTER 报错或重复应用。
      expect(migrate(ctx.db).applied).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("V4 追加判定追溯列，旧行可空，重复迁移不重复加列（AC5）", () => {
    const ctx = createTestDb();
    try {
      const columns = ctx.db
        .prepare("PRAGMA table_info(evaluations)")
        .all() as Array<{ name: string; notnull: number }>;
      const names = columns.map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "model_result",
          "decision_reason",
          "decision_policy_version",
          "decision_policy_json",
          "jev_request_id",
        ]),
      );
      // 全部为可空列：旧行保持 NULL，不回填。
      for (const column of columns) {
        if (
          [
            "model_result",
            "decision_reason",
            "decision_policy_version",
            "decision_policy_json",
            "jev_request_id",
          ].includes(column.name)
        ) {
          expect(column.notnull).toBe(0);
        }
      }

      expect(migrate(ctx.db).applied).toEqual([]);
    } finally {
      ctx.close();
    }
  });
});
