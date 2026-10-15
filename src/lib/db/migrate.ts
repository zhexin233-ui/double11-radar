import type Database from "better-sqlite3";
import { migrations, type Migration } from "@/lib/db/migrations";

/**
 * 应用数据库迁移。
 *
 * 使用 `BEGIN IMMEDIATE` 事务，按 `schema_migrations` 逐条应用，幂等且可重复调用。
 * web 由 instrumentation.register() 调用一次；worker 启动时调用一次。
 *
 * 关键：已应用版本必须在 `BEGIN IMMEDIATE` **事务内**读取。若在事务外先读快照，
 * web/worker 两个进程同时启动时都会拿到「尚未应用 V2」的旧快照，随后各自尝试应用，
 * 导致重复执行迁移 DDL/数据搬迁。把读取放进事务后，写锁使两个进程串行，
 * 第二个进程读到的是第一个进程提交后的版本。
 */
export function migrate(
  db: Database.Database,
  list: Migration[] = migrations,
): { applied: number[] } {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );

  const appliedNow: number[] = [];
  const ordered = [...list].sort((a, b) => a.version - b.version);

  const run = db.transaction(() => {
    // 在事务（写锁）内重新读取已应用版本，避免并发启动竞态。
    const rows = db
      .prepare("SELECT version FROM schema_migrations")
      .all() as Array<{ version: number }>;
    const applied = new Set(rows.map((row) => row.version));

    for (const migration of ordered) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      migration.run?.(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
      appliedNow.push(migration.version);
    }
  });

  run.immediate();

  return { applied: appliedNow };
}
