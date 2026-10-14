import type Database from "better-sqlite3";
import { requireSession } from "@/lib/auth/guard";
import { getDb } from "@/lib/db/client";
import { loadEnv, type AppEnv } from "@/lib/env";

/**
 * 路由处理器的服务端辅助。
 * 所有配置、记录、测试与重试接口都必须在服务端校验会话，不能仅靠前端跳转。
 */

export function getDatabase(): Database.Database {
  return getDb();
}

export function getEnv(): AppEnv {
  return loadEnv();
}

/** 会话校验通过后返回数据库连接；未登录抛 401。 */
export function requireAuth(req: Request): Database.Database {
  const database = getDb();
  requireSession(database, req);
  return database;
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}
