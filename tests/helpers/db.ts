import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

/** 在 os.tmpdir 下创建一个已迁移的临时 SQLite 数据库。 */
export interface TestDb {
  db: Database.Database;
  dir: string;
  dbPath: string;
  close: () => void;
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = getDb(dbPath);
  migrate(db);
  return {
    db,
    dir,
    dbPath,
    close: () => {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 32 字节测试密钥。 */
export function testKey(fill = 7): Buffer {
  return Buffer.alloc(32, fill);
}
