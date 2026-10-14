import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { loadEnv } from "@/lib/env";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { createNeed } from "@/lib/db/repos/needs";
import { saveJevConfig } from "@/lib/service/config";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";

/**
 * 判断并发与每轮任务数（网页可配）的回归测试。
 * 外部传输层是注入的假实现，验证的是「同时最多几个 Jev 请求在途」。
 */

const KEY = testKey();
const ENV = loadEnv();

function seedJobs(ctx: ReturnType<typeof createTestDb>, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const bulletin = insertBulletinIfAbsent(
      ctx.db,
      makeNormalized({ sourceId: `conc-${i}`, title: `并发样例 ${i}` }),
      { baseline: false },
    );
    enqueueJob(ctx.db, {
      kind: "evaluate",
      payloadKey: `evaluate:${bulletin.id}`,
      payload: { bulletinId: bulletin.id },
      // 提前到过去，保证每轮都能领到
      runAt: "2000-01-01T00:00:00.000Z",
    });
  }
}

function countingTransport(delayMs = 10) {
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const callSystemOne = vi.fn(
    async (_config: unknown, request: { questions: Record<string, unknown> }) => {
      state.calls += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.inFlight -= 1;
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "choice", choice: "not_matched" },
          ]),
        ),
      };
    },
  );
  return { state, callSystemOne };
}

describe("Jev 并发与每轮任务数可配（默认串行）", () => {
  it("默认：并发 1、每轮 3 个任务，实测同时只有 1 个请求在途", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-test" }, KEY);
      seedJobs(ctx, 6);
      const { state, callSystemOne } = countingTransport();

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
      });

      expect(result.processed).toBe(3); // 默认每轮 3 个
      expect(state.maxInFlight).toBe(1); // 默认严格串行
    } finally {
      ctx.close();
    }
  });

  it("配置并发 3 + 每轮 6 后：同时最多 3 个请求在途，且一轮处理 6 个任务", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-test", concurrency: 3, jobsPerRound: 6 }, KEY);
      seedJobs(ctx, 6);
      const { state, callSystemOne } = countingTransport();

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
      });

      expect(result.processed).toBe(6);
      expect(state.calls).toBe(6);
      expect(state.maxInFlight).toBe(3);
      // 并发不应超过配置值
      expect(state.maxInFlight).toBeLessThanOrEqual(3);
    } finally {
      ctx.close();
    }
  });

  it("每轮任务数大于待办数时不会空转或多领", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-test", jobsPerRound: 20 }, KEY);
      seedJobs(ctx, 2);
      const { state, callSystemOne } = countingTransport();

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
      });
      expect(result.processed).toBe(2);
      expect(state.calls).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("配置改动立即生效（同一进程内下一轮读取新值）", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-test", concurrency: 1, jobsPerRound: 1 }, KEY);
      seedJobs(ctx, 4);

      const first = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: countingTransport().callSystemOne as never,
      });
      expect(first.processed).toBe(1);

      saveJevConfig(ctx.db, { concurrency: 2, jobsPerRound: 3 }, KEY);
      const second = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: countingTransport().callSystemOne as never,
      });
      expect(second.processed).toBe(3);
    } finally {
      ctx.close();
    }
  });
});
