import type Database from "better-sqlite3";
import { migrations, type Migration } from "@/lib/db/migrations";

/**
 * 应用数据库迁移。
 *
 * 使用 BEGIN IMMEDIATE 事务，按 schema_migrations 逐条应用，幂等且可重复调用。
 * web 由 instrumentation.register() 调用一次；worker 启动时调用一次。
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

  const rows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  const applied = new Set(rows.map((row) => row.version));

  const appliedNow: number[] = [];
  const ordered = [...list].sort((a, b) => a.version - b.version);

  const run = db.transaction(() => {
    for (const migration of ordered) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
      appliedNow.push(migration.version);
    }
  });

  run.immediate();

  return { applied: appliedNow };
}
