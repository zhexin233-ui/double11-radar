import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "@/lib/db/repos/settings";
import { currentDbPath, resolveDbPath } from "@/lib/db/client";

export const STORAGE_SETTING_NAMESPACE = "storage";

export interface StorageSettings {
  /** 超过多少天就自动清理历史线报，0 表示不开启超期自动清理 */
  retentionDays: number;
  /** 是否开启后台周期性自动清理 */
  autoCleanupEnabled: boolean;
  /** 是否只清理未命中的线报（默认 false：清理所有超期线报） */
  cleanOnlyUnmatched: boolean;
  /** 上次清理执行时间（ISO 字符串） */
  lastCleanupAt?: string | null;
  /** 上次清理的线报条数 */
  lastCleanedCount?: number | null;
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  retentionDays: 30,
  autoCleanupEnabled: true,
  cleanOnlyUnmatched: false,
  lastCleanupAt: null,
  lastCleanedCount: null,
};

export interface StorageStats {
  /** 主数据库文件大小（bytes） */
  dbSizeBytes: number;
  dbSizeFormatted: string;
  /** WAL 日志文件大小（bytes） */
  walSizeBytes: number;
  walSizeFormatted: string;
  /** 总存储占用（bytes，包含主库、WAL 与 SHM） */
  totalSizeBytes: number;
  totalSizeFormatted: string;
  /** 数据库文件绝对路径 */
  dbPath: string;
  /** 各表行数统计 */
  tableCounts: {
    bulletins: number;
    evaluations: number;
    deliveries: number;
    notifications: number;
    bulletinProcessing: number;
    jevRequests: number;
    jobs: number;
  };
  /** 按照当前 retentionDays 超过保留期限的待清理线报数 */
  expiredBulletinsCount: number;
}

export interface CleanupResult {
  cleanedBulletins: number;
  cleanedEvaluations: number;
  cleanedDeliveries: number;
  cleanedNotifications: number;
  cleanedProcessing: number;
  cleanedJobs: number;
  durationMs: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/** 获取存储配置 */
export function getStorageSettings(db: Database.Database): StorageSettings {
  const row = getSetting<Partial<StorageSettings>>(db, STORAGE_SETTING_NAMESPACE);
  if (!row) {
    return { ...DEFAULT_STORAGE_SETTINGS };
  }
  return {
    retentionDays:
      typeof row.value.retentionDays === "number" && row.value.retentionDays >= 0
        ? Math.floor(row.value.retentionDays)
        : DEFAULT_STORAGE_SETTINGS.retentionDays,
    autoCleanupEnabled:
      typeof row.value.autoCleanupEnabled === "boolean"
        ? row.value.autoCleanupEnabled
        : DEFAULT_STORAGE_SETTINGS.autoCleanupEnabled,
    cleanOnlyUnmatched:
      typeof row.value.cleanOnlyUnmatched === "boolean"
        ? row.value.cleanOnlyUnmatched
        : DEFAULT_STORAGE_SETTINGS.cleanOnlyUnmatched,
    lastCleanupAt: row.value.lastCleanupAt ?? null,
    lastCleanedCount:
      typeof row.value.lastCleanedCount === "number"
        ? row.value.lastCleanedCount
        : null,
  };
}

/** 保存存储配置 */
export function saveStorageSettings(
  db: Database.Database,
  patch: Partial<StorageSettings>,
): StorageSettings {
  const current = getStorageSettings(db);
  const updated: StorageSettings = {
    ...current,
    ...patch,
  };
  setSetting(db, STORAGE_SETTING_NAMESPACE, updated);
  return updated;
}

/** 获取指定保留天数对应的截止时间 ISO 字符串 */
export function computeCutoffDate(retentionDays: number, now = new Date()): string {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString();
}

function safeFileSize(filePath: string): number {
  try {
    if (fs.existsSync(filePath)) {
      return fs.statSync(filePath).size;
    }
  } catch {
    // 忽略异常
  }
  return 0;
}

function getTableCount(db: Database.Database, tableName: string): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`)
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 统计待清理的超期线报条数
 */
export function countExpiredBulletins(
  db: Database.Database,
  retentionDays: number,
  cleanOnlyUnmatched: boolean,
): number {
  if (retentionDays <= 0) return 0;
  const cutoff = computeCutoffDate(retentionDays);

  let sql = `SELECT COUNT(*) AS count FROM bulletins b WHERE b.created_at < ?`;
  const params: unknown[] = [cutoff];

  if (cleanOnlyUnmatched) {
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id AND e.result = 'matched'
    ) AND NOT EXISTS (
      SELECT 1 FROM notifications n WHERE n.bulletin_id = b.id
    )`;
  }

  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * 获取实时存储占用与数据规模统计
 */
export function getStorageStats(db: Database.Database): StorageStats {
  const targetDbPath = currentDbPath() ?? resolveDbPath();
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;

  const dbSizeBytes = safeFileSize(targetDbPath);
  const walSizeBytes = safeFileSize(walPath);
  const shmSizeBytes = safeFileSize(shmPath);
  const totalSizeBytes = dbSizeBytes + walSizeBytes + shmSizeBytes;

  const settings = getStorageSettings(db);
  const expiredCount = countExpiredBulletins(
    db,
    settings.retentionDays,
    settings.cleanOnlyUnmatched,
  );

  return {
    dbSizeBytes,
    dbSizeFormatted: formatBytes(dbSizeBytes),
    walSizeBytes,
    walSizeFormatted: formatBytes(walSizeBytes),
    totalSizeBytes,
    totalSizeFormatted: formatBytes(totalSizeBytes),
    dbPath: targetDbPath,
    tableCounts: {
      bulletins: getTableCount(db, "bulletins"),
      evaluations: getTableCount(db, "evaluations"),
      deliveries: getTableCount(db, "deliveries"),
      notifications: getTableCount(db, "notifications"),
      bulletinProcessing: getTableCount(db, "bulletin_processing"),
      jevRequests: getTableCount(db, "jev_requests"),
      jobs: getTableCount(db, "jobs"),
    },
    expiredBulletinsCount: expiredCount,
  };
}

export interface CleanupOptions {
  retentionDays?: number;
  cleanOnlyUnmatched?: boolean;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * 执行超期历史线报清理。
 * 分批进行事务删除，级联清理附属记录，避免单次大事务锁库过久。
 */
export function cleanupExpiredBulletins(
  db: Database.Database,
  options?: CleanupOptions,
): CleanupResult {
  const startTime = Date.now();
  const settings = getStorageSettings(db);
  const retentionDays = options?.retentionDays ?? settings.retentionDays;
  const cleanOnlyUnmatched =
    options?.cleanOnlyUnmatched ?? settings.cleanOnlyUnmatched;
  const batchSize = Math.max(10, Math.min(1000, options?.batchSize ?? 500));
  const maxBatches = options?.maxBatches ?? 20;

  let totalCleanedBulletins = 0;
  let totalCleanedEvaluations = 0;
  let totalCleanedDeliveries = 0;
  let totalCleanedNotifications = 0;
  let totalCleanedProcessing = 0;
  let totalCleanedJobs = 0;

  if (retentionDays <= 0) {
    return {
      cleanedBulletins: 0,
      cleanedEvaluations: 0,
      cleanedDeliveries: 0,
      cleanedNotifications: 0,
      cleanedProcessing: 0,
      cleanedJobs: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const cutoff = computeCutoffDate(retentionDays);

  for (let batch = 0; batch < maxBatches; batch++) {
    // 找出本批待删除的 bulletin IDs
    // 保护条件：若有未完成的任务在处理，不删除（避免破坏在途任务）
    let selectSql = `
      SELECT b.id FROM bulletins b
      WHERE b.created_at < ?
    `;
    if (cleanOnlyUnmatched) {
      selectSql += `
        AND NOT EXISTS (
          SELECT 1 FROM evaluations e WHERE e.bulletin_id = b.id AND e.result = 'matched'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notifications n WHERE n.bulletin_id = b.id
        )
      `;
    }
    selectSql += `
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.payload_key = ('evaluate:' || b.id)
          AND j.status IN ('pending', 'leased')
      )
      LIMIT ?
    `;

    const candidateRows = db.prepare(selectSql).all(cutoff, batchSize) as Array<{
      id: string;
    }>;

    if (candidateRows.length === 0) {
      break;
    }

    const ids = candidateRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    // 单批事务删除
    const executeBatch = db.transaction(() => {
      // 1. 删除关联的 evaluations
      const rEvals = db
        .prepare(`DELETE FROM evaluations WHERE bulletin_id IN (${placeholders})`)
        .run(...ids);
      // 2. 删除关联的 deliveries
      const rDeliveries = db
        .prepare(`DELETE FROM deliveries WHERE bulletin_id IN (${placeholders})`)
        .run(...ids);
      // 3. 删除关联的 notifications
      const rNotifs = db
        .prepare(`DELETE FROM notifications WHERE bulletin_id IN (${placeholders})`)
        .run(...ids);
      // 4. 删除关联的 bulletin_processing
      const rProcessing = db
        .prepare(`DELETE FROM bulletin_processing WHERE bulletin_id IN (${placeholders})`)
        .run(...ids);
      // 5. 删除关联已完成/失效的 jobs
      const jobKeys = ids.map((id) => `evaluate:${id}`);
      const jobPlaceholders = jobKeys.map(() => "?").join(",");
      const rJobs = db
        .prepare(`DELETE FROM jobs WHERE payload_key IN (${jobPlaceholders})`)
        .run(...jobKeys);
      // 6. 最后删除 bulletins 本身
      const rBulletins = db
        .prepare(`DELETE FROM bulletins WHERE id IN (${placeholders})`)
        .run(...ids);

      return {
        evaluations: rEvals.changes,
        deliveries: rDeliveries.changes,
        notifications: rNotifs.changes,
        processing: rProcessing.changes,
        jobs: rJobs.changes,
        bulletins: rBulletins.changes,
      };
    });

    const result = executeBatch();
    totalCleanedBulletins += result.bulletins;
    totalCleanedEvaluations += result.evaluations;
    totalCleanedDeliveries += result.deliveries;
    totalCleanedNotifications += result.notifications;
    totalCleanedProcessing += result.processing;
    totalCleanedJobs += result.jobs;

    if (candidateRows.length < batchSize) {
      break;
    }
  }

  // 记录最后一次清理状态
  saveStorageSettings(db, {
    lastCleanupAt: new Date().toISOString(),
    lastCleanedCount: totalCleanedBulletins,
  });

  return {
    cleanedBulletins: totalCleanedBulletins,
    cleanedEvaluations: totalCleanedEvaluations,
    cleanedDeliveries: totalCleanedDeliveries,
    cleanedNotifications: totalCleanedNotifications,
    cleanedProcessing: totalCleanedProcessing,
    cleanedJobs: totalCleanedJobs,
    durationMs: Date.now() - startTime,
  };
}

/**
 * 执行 SQLite VACUUM 释放磁盘碎片
 */
export function vacuumDatabase(db: Database.Database): {
  success: boolean;
  beforeBytes: number;
  afterBytes: number;
  savedBytes: number;
  savedFormatted: string;
} {
  const targetDbPath = currentDbPath() ?? resolveDbPath();
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;
  const beforeBytes =
    safeFileSize(targetDbPath) + safeFileSize(walPath) + safeFileSize(shmPath);

  // WAL 模式下执行 VACUUM 是安全的
  db.exec("VACUUM");

  const afterBytes =
    safeFileSize(targetDbPath) + safeFileSize(walPath) + safeFileSize(shmPath);
  const savedBytes = Math.max(0, beforeBytes - afterBytes);

  return {
    success: true,
    beforeBytes,
    afterBytes,
    savedBytes,
    savedFormatted: formatBytes(savedBytes),
  };
}
