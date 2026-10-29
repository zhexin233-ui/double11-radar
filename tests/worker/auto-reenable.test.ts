import { expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import * as dbClient from "@/lib/db/client";
import { loadEnv } from "@/lib/env";
import { addJevKey } from "@/lib/service/jev-keys";
import { getJevKey, recordJevKeyFailure } from "@/lib/db/repos/jev-keys";
import { startWorker } from "@/worker/main";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import { runSystemAlertDelivererOnce } from "@/lib/worker/system-alert-deliverer";

vi.mock("@/lib/worker/collector", () => ({ runCollectorOnce: vi.fn(async () => 0) }));
vi.mock("@/lib/worker/evaluator", () => ({ runEvaluatorOnce: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/lib/worker/deliverer", () => ({ runDelivererOnce: vi.fn(async () => 0) }));
vi.mock("@/lib/worker/system-alert-deliverer", () => ({ runSystemAlertDelivererOnce: vi.fn(() => new Promise(() => {})) }));

it("启动补处理到期计划；慢判断与通知不阻塞5秒恢复，停止时清理定时器（A5）", async () => {
  const ctx = createTestDb();
  let stop: (() => void) | undefined;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
  const failTen = (id: string, generation: number, now: Date) => {
    for (let i = 0; i < 10; i++) recordJevKeyFailure(ctx.db, { keyId: id, generation, now, error: "测试失败" });
  };
  try {
    vi.spyOn(dbClient, "getDb").mockReturnValue(ctx.db);
    const key = addJevKey(ctx.db, { label: "worker测试", apiKey: "sk-worker-test", autoReenableEnabled: true, autoReenableMinutes: 1 }, testKey());
    failTen(key.id, key.generation, new Date(Date.now() - 60_000));
    stop = await startWorker(loadEnv());
    expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, generation: 2 });
    failTen(key.id, 2, new Date(Date.now() - 59_000));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(getJevKey(ctx.db, key.id)?.enabled).toBe(false);
    expect(runEvaluatorOnce).toHaveBeenCalledTimes(1);
    expect(runSystemAlertDelivererOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, generation: 3 });
    failTen(key.id, 3, new Date(Date.now() - 60_000));
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getJevKey(ctx.db, key.id)?.enabled).toBe(false);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM jev_requests").get()).toEqual({ n: 0 });
  } finally { stop?.(); vi.restoreAllMocks(); vi.useRealTimers(); ctx.close(); }
});
