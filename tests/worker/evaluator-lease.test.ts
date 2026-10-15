import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { loadEnv } from "@/lib/env";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { enqueueJob, getJob } from "@/lib/db/repos/jobs";
import { createNeed } from "@/lib/db/repos/needs";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import {
  insertInFlightRequest,
  countActiveInFlight,
} from "@/lib/db/repos/jev-requests";
import { LEGACY_JEV_KEY_ID } from "@/lib/db/migrations";
import { getJevKey } from "@/lib/db/repos/jev-keys";
import { addJevKey, updateJevKeySettings } from "@/lib/service/jev-keys";
import { saveJevConfig } from "@/lib/service/config";
import { questionIdForNeed } from "@/lib/jev/prompt";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";

/**
 * 判断租约与全池不可用的恢复语义（AC3）。
 *
 * 外部传输层是注入的假实现，不连接真实上游；断言的是「失去 ownership 不落判断」、
 * 「配置问题不耗尽尝试」与「容量占满只延后」这三条异步边界。
 */

const KEY = testKey();
const ENV = loadEnv();

type Ctx = ReturnType<typeof createTestDb>;

function countRows(db: Ctx["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function seedJob(ctx: Ctx, sourceId: string, runAt?: string): {
  bulletinId: string;
  jobId: string;
} {
  const { id: bulletinId } = insertBulletinIfAbsent(
    ctx.db,
    makeNormalized({ sourceId, title: `样例 ${sourceId}` }),
    { baseline: false },
  );
  const { id: jobId } = enqueueJob(ctx.db, {
    kind: "evaluate",
    payloadKey: `evaluate:${bulletinId}`,
    payload: { bulletinId },
    ...(runAt ? { runAt } : {}),
  });
  return { bulletinId, jobId };
}

describe("失去 job ownership 的结果不落库（AC3）", () => {
  it("旧租约的迟到判断不写 evaluation/通知，但真实用量仍记一次账", async () => {
    const ctx = createTestDb();
    try {
      const need = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-eval", jobsPerRound: 1, concurrency: 1 }, KEY);
      const { bulletinId, jobId } = seedJob(ctx, "lease-1");
      const questionId = questionIdForNeed(need.id);

      const callSystemOne = vi.fn(async () => {
        // 模拟另一连接回收该 job（把任务改回 pending）
        ctx.db
          .prepare(
            "UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          )
          .run(jobId);
        return {
          model: "jev-1.13.0",
          answers: { [questionId]: { type: "choice", choice: "matched" } },
          usage: { inputTokens: 100, outputTokens: null },
          httpStatus: 200,
          upstreamRequestId: "req-lost-lease",
        };
      });

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
      });

      expect(result.matched).toBe(0);
      expect(result.processed).toBe(0);
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)).toHaveLength(0);
      expect(countRows(ctx.db, "notifications")).toBe(0);
      expect(countRows(ctx.db, "deliveries")).toBe(0);

      // 真实请求已发出且返回，用量账本必须记一次（成功）
      const ledger = ctx.db
        .prepare("SELECT status FROM jev_requests")
        .all() as Array<{ status: string }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe("succeeded");
    } finally {
      ctx.close();
    }
  });
});

describe("阻塞与容量问题不耗尽普通尝试（AC3）", () => {
  it("密钥全部禁用时任务保持 pending、不写判断、给出中文错误", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { jobsPerRound: 1, concurrency: 1 }, KEY);
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      updateJevKeySettings(ctx.db, key.id, { enabled: false }, KEY);
      const { bulletinId, jobId } = seedJob(ctx, "blocked-1");

      const callSystemOne = vi.fn();
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: callSystemOne as never });

      expect(callSystemOne).not.toHaveBeenCalled();
      const job = getJob(ctx.db, jobId)!;
      expect(job.status).toBe("pending");
      expect(job.lastError).toMatch(/[\u4e00-\u9fff]/);
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)).toHaveLength(0);
      expect(countRows(ctx.db, "jev_requests")).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("容量占满时只延后重排，不累计尝试次数、不新增账本", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-a", jobsPerRound: 1, concurrency: 1 },
        KEY,
      );
      const legacy = getJevKey(ctx.db, LEGACY_JEV_KEY_ID)!;
      const now = new Date("2026-10-14T00:00:00.000Z");

      // 手工占用唯一容量槽：租约远未到期，不会被回收
      insertInFlightRequest(ctx.db, {
        keyId: legacy.id,
        keyLabel: legacy.label,
        keyGeneration: legacy.generation,
        purpose: "evaluate",
        requestedModel: "jev-latest",
        providerOrigin: "https://api.typesafe.ai",
        configVersion: 1,
        startedAt: now,
        leaseUntil: new Date(now.getTime() + 3_600_000),
      });
      const { bulletinId, jobId } = seedJob(ctx, "busy-1", now.toISOString());

      const callSystemOne = vi.fn();
      await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
        now: () => now,
      });

      expect(callSystemOne).not.toHaveBeenCalled();
      const job = getJob(ctx.db, jobId)!;
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(0);
      expect(job.lastError).toMatch(/[\u4e00-\u9fff]/);
      // 没有新调用：只剩手工插入的那一条
      expect(countRows(ctx.db, "jev_requests")).toBe(1);
      expect(countActiveInFlight(ctx.db, now)).toBe(1);
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("一条线报的全部启用需求合并为一次请求，且各自独立保存结果（AC4）", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸", note: "不要湿巾" });
      const makeup = createNeed(ctx.db, { name: "卸妆膏" });
      saveJevConfig(ctx.db, { apiKey: "sk-ac4" }, KEY);
      const { bulletinId } = seedJob(ctx, "ac4-1");

      const callSystemOne = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: {
            [questionIdForNeed(paper.id)]: { type: "choice", choice: "matched" },
            [questionIdForNeed(makeup.id)]: { type: "choice", choice: "not_matched" },
          },
        }),
      );

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
      });

      // 只发一次请求，且同一个请求携带两个独立问题（不是互斥选项）。
      expect(callSystemOne).toHaveBeenCalledTimes(1);
      const [, request] = callSystemOne.mock.calls[0] as unknown as [
        unknown,
        { questions: Record<string, unknown> },
      ];
      expect(Object.keys(request.questions).sort()).toEqual(
        [questionIdForNeed(paper.id), questionIdForNeed(makeup.id)].sort(),
      );

      // 每个需求各自保存结果：命中一个即产生一条通知。
      const evaluations = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(evaluations).toHaveLength(2);
      const byName = Object.fromEntries(
        evaluations.map((evaluation) => [evaluation.needName, evaluation.result]),
      );
      expect(byName["抽纸"]).toBe("matched");
      expect(byName["卸妆膏"]).toBe("not_matched");
      expect(result.matched).toBe(1);
      expect(countRows(ctx.db, "notifications")).toBe(1);
      // 一次实际调用 → 账本也恰好一行。
      expect(countRows(ctx.db, "jev_requests")).toBe(1);
    } finally {
      ctx.close();
    }
  });
});
