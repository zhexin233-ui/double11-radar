import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db/migrate";
import {
  getStorageSettings,
  saveStorageSettings,
  getStorageStats,
  cleanupExpiredBulletins,
  vacuumDatabase,
  computeCutoffDate,
} from "@/lib/service/storage";

describe("storage service", () => {
  let db: Database.Database;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-storage-"));
    dbPath = path.join(tmpDir, "xianbao.db");
    db = new Database(dbPath);
    migrate(db);
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should get default storage settings and update them", () => {
    const settings = getStorageSettings(db);
    expect(settings.retentionDays).toBe(30);
    expect(settings.autoCleanupEnabled).toBe(true);
    expect(settings.cleanOnlyUnmatched).toBe(false);

    const updated = saveStorageSettings(db, {
      retentionDays: 15,
      autoCleanupEnabled: false,
      cleanOnlyUnmatched: true,
    });
    expect(updated.retentionDays).toBe(15);
    expect(updated.autoCleanupEnabled).toBe(false);
    expect(updated.cleanOnlyUnmatched).toBe(true);

    const reloaded = getStorageSettings(db);
    expect(reloaded.retentionDays).toBe(15);
    expect(reloaded.autoCleanupEnabled).toBe(false);
    expect(reloaded.cleanOnlyUnmatched).toBe(true);
  });

  it("should calculate storage stats and handle empty tables", () => {
    const stats = getStorageStats(db);
    expect(stats.tableCounts.bulletins).toBe(0);
    expect(stats.expiredBulletinsCount).toBe(0);
    expect(stats.totalSizeBytes).toBeGreaterThanOrEqual(0);
  });

  it("should cleanup expired bulletins and cascade delete related rows", () => {
    // 插入两条过期线报（10天前），一条不过期线报（1小时前）
    const tenDaysAgo = computeCutoffDate(10);
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

    db.prepare(`
      INSERT INTO bulletins (id, source, source_ns, source_id, url, title, payload, content_version, created_at)
      VALUES
        ('b-old-1', 'test', 'ns', '1', 'http://1', 'old title 1', '{}', '1', ?),
        ('b-old-2', 'test', 'ns', '2', 'http://2', 'old title 2', '{}', '1', ?),
        ('b-new', 'test', 'ns', '3', 'http://3', 'new title', '{}', '1', ?)
    `).run(tenDaysAgo, tenDaysAgo, oneHourAgo);

    // 关联附属数据
    db.prepare(`
      INSERT INTO evaluations (id, bulletin_id, need_id, need_name, need_note, need_version, config_version, rule_version, result, created_at, updated_at)
      VALUES
        ('e-1', 'b-old-1', 'need-1', 'n1', '', 1, 1, 'v1', 'not_matched', ?, ?),
        ('e-2', 'b-new', 'need-1', 'n1', '', 1, 1, 'v1', 'matched', ?, ?)
    `).run(tenDaysAgo, tenDaysAgo, oneHourAgo, oneHourAgo);

    db.prepare(`
      INSERT INTO notifications (id, bulletin_id, payload, created_at)
      VALUES ('notif-1', 'b-old-1', '{}', ?)
    `).run(tenDaysAgo);

    db.prepare(`
      INSERT INTO deliveries (id, notification_id, bulletin_id, channel, status, created_at, updated_at)
      VALUES ('del-1', 'notif-1', 'b-old-1', 'bark', 'succeeded', ?, ?)
    `).run(tenDaysAgo, tenDaysAgo);

    db.prepare(`
      INSERT INTO jobs (id, kind, status, payload_key, payload, run_at, created_at, updated_at)
      VALUES
        ('job-1', 'evaluate', 'succeeded', 'evaluate:b-old-1', '{}', ?, ?, ?),
        ('job-2', 'evaluate', 'pending', 'evaluate:b-new', '{}', ?, ?, ?)
    `).run(tenDaysAgo, tenDaysAgo, tenDaysAgo, oneHourAgo, oneHourAgo, oneHourAgo);

    // 保留 7 天以上数据进行清理
    const result = cleanupExpiredBulletins(db, { retentionDays: 7 });
    expect(result.cleanedBulletins).toBe(2);
    expect(result.cleanedEvaluations).toBe(1);
    expect(result.cleanedNotifications).toBe(1);
    expect(result.cleanedDeliveries).toBe(1);
    expect(result.cleanedJobs).toBe(1);

    // 校验剩余数据
    const remainingBulletins = db.prepare("SELECT id FROM bulletins").all() as Array<{ id: string }>;
    expect(remainingBulletins.map(r => r.id)).toEqual(["b-new"]);

    const remainingEvals = db.prepare("SELECT id FROM evaluations").all() as Array<{ id: string }>;
    expect(remainingEvals.map(r => r.id)).toEqual(["e-2"]);

    const remainingJobs = db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>;
    expect(remainingJobs.map(r => r.id)).toEqual(["job-2"]);
  });

  it("should vacuum database successfully", () => {
    const vacuumRes = vacuumDatabase(db);
    expect(vacuumRes.success).toBe(true);
    expect(typeof vacuumRes.savedBytes).toBe("number");
  });
});
