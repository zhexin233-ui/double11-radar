import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadEnv } from "@/lib/env";

/**
 * better-sqlite3 连接单例（服务端 only）。
 *
 * - 默认库路径为 `$DATA_DIR/xianbao.db`；
 * - 已开启 WAL、busy_timeout=5000、foreign_keys=ON；
 * - 测试可传入显式路径，切换路径时会关闭旧连接。
 */

let db: Database.Database | null = null;
let currentPath: string | null = null;

/** 由 DATA_DIR 推导数据库文件路径。 */
export function resolveDbPath(dataDir?: string): string {
  const dir = dataDir ?? loadEnv().dataDir;
  return path.join(dir, "xianbao.db");
}

/** 获取数据库连接；传入路径时按路径缓存单例。 */
export function getDb(dbPath?: string): Database.Database {
  const target = dbPath ?? resolveDbPath();
  if (db && currentPath === target) {
    return db;
  }
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const instance = new Database(target);
  instance.pragma("journal_mode = WAL");
  instance.pragma("busy_timeout = 5000");
  instance.pragma("foreign_keys = ON");
  db = instance;
  currentPath = target;
  return instance;
}

/** 关闭并重置单例（测试与脚本退出时使用）。 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
}

/** 当前连接指向的数据库路径，未连接时为 null。 */
export function currentDbPath(): string | null {
  return currentPath;
}
