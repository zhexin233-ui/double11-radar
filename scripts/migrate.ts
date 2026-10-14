import { loadEnv } from "../src/lib/env";
import { closeDb, getDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";

/**
 * 独立迁移脚本：`pnpm migrate`。
 * web（instrumentation）与 worker 也会各自调用一次，二者幂等。
 */
function main(): void {
  const env = loadEnv();
  const db = getDb();
  const { applied } = migrate(db);
  if (applied.length === 0) {
    console.log(`数据库已是最新，无需迁移：${env.dataDir}/xianbao.db`);
  } else {
    console.log(`已应用迁移版本：${applied.join(", ")}`);
  }
  closeDb();
}

try {
  main();
} catch (error) {
  console.error(
    "迁移失败：",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
