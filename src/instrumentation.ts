/**
 * Next.js 启动钩子：仅在 Node.js runtime 下执行数据库迁移。
 * 使用动态 import，避免 edge runtime 打包 better-sqlite3 时报错。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getDb } = await import("@/lib/db/client");
  const { migrate } = await import("@/lib/db/migrate");

  migrate(getDb());
}
