import { getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { reclaimExpiredLeases } from "@/lib/db/repos/jobs";
import { reclaimExpiredRequestReservations } from "@/lib/db/repos/jev-requests";
import { ensureAdminCredential } from "@/lib/auth/password";
import { loadEnv, type AppEnv } from "@/lib/env";
import { runCollectorOnce } from "@/lib/worker/collector";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import { runDelivererOnce } from "@/lib/worker/deliverer";
import { disposeSharedRegexRunner } from "@/lib/service/regex-runner";
import { getRuntimeState, patchRuntimeState } from "@/lib/worker/runtime-state";

/**
 * 独立后台进程入口。
 *
 * - 与 web 共用同一个持久化数据库与加密密钥；
 * - 三个循环各自 try/catch，单轮或单个外部依赖失败不会退出进程；
 * - 关闭网页不影响本进程；
 * - 支持 SIGINT/SIGTERM 优雅退出。
 */

const HEARTBEAT_INTERVAL_MS = 30_000;
const COLLECT_INTERVAL_MS = 5_000;
const WORK_INTERVAL_MS = 2_000;

async function withGuard(
  label: string,
  fn: () => Promise<unknown>,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError(`[worker] ${label} 异常：${message}`);
  }
}

export async function startWorker(env: AppEnv): Promise<() => void> {
  const db = getDb();
  migrate(db);
  ensureAdminCredential(db, env);
  patchRuntimeState(db, {
    workerStartedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  });

  let running = true;
  // 各循环的重入保护：单轮可能因外部超时耗时较长，避免定时器叠加。
  let collecting = false;
  let working = false;

  const reportError = (message: string) => {
    console.error(message);
    patchRuntimeState(db, {
      lastError: message,
      lastErrorAt: new Date().toISOString(),
      lastErrorStage: "worker",
    });
  };

  const heartbeat = setInterval(() => {
    try {
      patchRuntimeState(db, { lastHeartbeatAt: new Date().toISOString() });
    } catch (error) {
      console.error("[worker] 心跳写入失败：", error);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const collectTimer = setInterval(() => {
    if (!running || collecting) return;
    collecting = true;
    void withGuard(
      "collector",
      () => {
        reclaimExpiredLeases(db);
        // 超期请求预留转为 interrupted：释放容量、费用未知，不伪造零账单。
        reclaimExpiredRequestReservations(db);
        return runCollectorOnce(db, env);
      },
      reportError,
    ).finally(() => {
      collecting = false;
    });
  }, COLLECT_INTERVAL_MS);

  const workTimer = setInterval(() => {
    if (!running || working) return;
    working = true;
    void withGuard(
      "evaluator",
      () => runEvaluatorOnce(db, env),
      reportError,
    )
      .then(() => withGuard("deliverer", () => runDelivererOnce(db, env), reportError))
      .finally(() => {
        working = false;
      });
  }, WORK_INTERVAL_MS);

  return () => {
    running = false;
    clearInterval(heartbeat);
    clearInterval(collectTimer);
    clearInterval(workTimer);
    // 释放正则执行线程，避免进程退出时遗留 worker。
    disposeSharedRegexRunner();
  };
}

async function main(): Promise<void> {
  let env: AppEnv;
  try {
    env = loadEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] 环境变量配置错误：${message}`);
    process.exitCode = 1;
    return;
  }

  const stop = await startWorker(env);
  console.log(
    `[worker] 已启动（数据目录 ${env.dataDir}，上次心跳 ${getRuntimeState(getDb()).lastHeartbeatAt ?? "-"}）`,
  );

  const shutdown = (signal: string) => {
    console.log(`[worker] 收到 ${signal}，正在退出…`);
    stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isDirectRun =
  process.argv[1] !== undefined &&
  /worker[\\/]main\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  void main();
}
