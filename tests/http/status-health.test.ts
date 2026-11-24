import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { createSession, generateToken } from "@/lib/auth/session";
import { enqueueJob, getJob, jobStats } from "@/lib/db/repos/jobs";
import { patchRuntimeState } from "@/lib/worker/runtime-state";
import { GET as getStatus } from "@/app/api/status/route";
import { POST as retryJobs } from "@/app/api/jobs/retry/route";

function makeReq(
  pathname: string,
  method: string,
  body?: unknown,
  token?: string,
  origin = "http://localhost:3000",
) {
  return new Request(`http://localhost:3000${pathname}`, {
    method,
    headers: {
      origin,
      host: "localhost:3000",
      "x-requested-with": "fetch",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      cookie: token ? `xianbao_session=${token}` : "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("运行状态健康判定与失败任务重试 API", () => {
  it("历史 dead 任务被同类型后续成功任务覆盖后不再阻塞 processingHealthy，且可手动重试", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-health-api-"));
    vi.stubEnv("DATA_DIR", dir);
    const db = getDb();
    migrate(db);
    try {
      const token = generateToken();
      createSession(db, token);
      const ctx = { params: Promise.resolve({}) };

      // 写入新鲜心跳
      patchRuntimeState(db, {
        lastHeartbeatAt: new Date().toISOString(),
      });

      // 1. 仅有一条 dead evaluate 任务（尚无后续成功）-> processingHealthy 必须为 false
      const deadEval = enqueueJob(db, {
        kind: "evaluate",
        payloadKey: "evaluate:old-dead",
        payload: { bulletinId: "old-dead" },
      });
      db.prepare(
        `UPDATE jobs SET status = 'dead', attempts = 5, last_error = '网络错误',
           updated_at = '2026-11-23T05:00:00.000Z' WHERE id = ?`,
      ).run(deadEval.id);

      let res = await getStatus(makeReq("/api/status", "GET", undefined, token), ctx);
      let data = (await res.json()).data;
      expect(data.jobs).toMatchObject({ dead: 1, activeDead: 1 });
      expect(data.processingHealthy).toBe(false);

      // 2. 同类型后续任务成功 -> 历史 dead 已被恢复覆盖，processingHealthy 恢复为 true
      const okEval = enqueueJob(db, {
        kind: "evaluate",
        payloadKey: "evaluate:newer-ok",
        payload: { bulletinId: "newer-ok" },
      });
      db.prepare(
        `UPDATE jobs SET status = 'succeeded', updated_at = '2026-11-24T11:00:00.000Z' WHERE id = ?`,
      ).run(okEval.id);

      res = await getStatus(makeReq("/api/status", "GET", undefined, token), ctx);
      data = (await res.json()).data;
      expect(data.jobs).toMatchObject({ dead: 1, activeDead: 0 });
      expect(data.processingHealthy).toBe(true);

      // 3. 另一种类型（analyze）出现未恢复的 dead 任务 -> 按 kind 隔离，processingHealthy 仍为 false
      const deadAnalyze = enqueueJob(db, {
        kind: "analyze",
        payloadKey: "analyze:b1",
        payload: { bulletinId: "b1" },
      });
      db.prepare(
        `UPDATE jobs SET status = 'dead', attempts = 3, last_error = '上游超时',
           updated_at = '2026-11-24T10:00:00.000Z' WHERE id = ?`,
      ).run(deadAnalyze.id);

      res = await getStatus(makeReq("/api/status", "GET", undefined, token), ctx);
      data = (await res.json()).data;
      expect(data.jobs).toMatchObject({ dead: 2, activeDead: 1 });
      expect(data.processingHealthy).toBe(false);

      // 4. 鉴权与同源校验
      expect(
        (await retryJobs(makeReq("/api/jobs/retry", "POST", {}), ctx)).status,
      ).toBe(401);
      expect(
        (
          await retryJobs(
            makeReq("/api/jobs/retry", "POST", {}, token, "https://evil.example"),
            ctx,
          )
        ).status,
      ).toBe(403);

      // 5. 单条重试 analyze dead 任务
      const retryOne = await retryJobs(
        makeReq("/api/jobs/retry", "POST", { id: deadAnalyze.id }, token),
        ctx,
      );
      expect(retryOne.status).toBe(200);
      expect((await retryOne.json()).data).toEqual({ retried: 1 });
      expect(getJob(db, deadAnalyze.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: null,
      });

      // 重复重试同一条（已不是 dead）返回 409
      const retryAgain = await retryJobs(
        makeReq("/api/jobs/retry", "POST", { id: deadAnalyze.id }, token),
        ctx,
      );
      expect(retryAgain.status).toBe(409);

      // 6. 批量重试剩余全部 dead 任务
      const retryAll = await retryJobs(
        makeReq("/api/jobs/retry", "POST", {}, token),
        ctx,
      );
      expect(retryAll.status).toBe(200);
      expect((await retryAll.json()).data).toEqual({ retried: 1 });
      expect(jobStats(db)).toMatchObject({ dead: 0, activeDead: 0, pending: 2 });
    } finally {
      closeDb();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
