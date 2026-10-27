import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { addJevKey, updateJevKeySettings } from "@/lib/service/jev-keys";
import { saveJevConfig } from "@/lib/service/config";
import {
  callJevWithLedger,
  reserveJevCall,
  type JevReserveOk,
} from "@/lib/service/jev-requests";
import {
  completeJevRequest,
  countActiveInFlight,
  getJevRequest,
  getJevUsageSummary,
  insertInFlightRequest,
  reclaimExpiredRequestReservations,
} from "@/lib/db/repos/jev-requests";
import { getJevKey, setJevKeyCooldown } from "@/lib/db/repos/jev-keys";
import { getJevCooldown, setJevCooldown } from "@/lib/db/repos/jev-cooldown";
import { claimJob, enqueueJob, getJob } from "@/lib/db/repos/jobs";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { makeNormalized } from "../helpers/bulletins";
import { JevError } from "@/lib/jev/client";

/**
 * 统一 Jev 请求服务：容量、Key 选择、失败计数与调用账本（AC1/AC2/AC3/AC6）。
 *
 * 只 mock 传输层（`callSystemOne`），不连接真实上游、不依赖真实时钟。
 */

const KEY = testKey();

type Db = ReturnType<typeof createTestDb>["db"];

const QUESTIONS = {
  q1: {
    type: "choice" as const,
    criteria: { matched: "a", not_matched: "b", uncertain: "c" },
    instructions: "i",
  },
};

function requestCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM jev_requests").get() as { c: number }).c;
}

function requireOk(result: ReturnType<typeof reserveJevCall>): JevReserveOk {
  if (!result.ok) throw new Error(`预期预留成功，实际：${result.reason}`);
  return result;
}

function succeeding() {
  return vi.fn(async () => ({
    model: "jev-1.13.0",
    answers: { q1: { type: "choice", choice: "matched" } },
    usage: { inputTokens: 10, outputTokens: null },
    httpStatus: 200,
    upstreamRequestId: "req-ok",
  }));
}

function failing(status = 500) {
  return vi.fn(async () => {
    throw new JevError(`Jev 返回 HTTP ${status}`, { status, retryable: status >= 500 });
  });
}

describe("容量与 Key 选择（AC1）", () => {
  it("并发上限 1 时第二个预留返回 busy，且不写账本", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-1" }, KEY);
      const first = reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY);
      expect(first.ok).toBe(true);

      const second = reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("busy");
      expect(requestCount(ctx.db)).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("并发上限 2 时可同时预留两条", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-1", concurrency: 2 }, KEY);
      expect(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY).ok).toBe(true);
      expect(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY).ok).toBe(true);
      expect(requestCount(ctx.db)).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it("两个 Key 均匀分摊，再次预留选择在途更少的 Key", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 4 }, KEY);
      addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      addJevKey(ctx.db, { label: "B", apiKey: "sk-b" }, KEY);

      const r1 = requireOk(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY));
      const r2 = requireOk(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY));
      expect(new Set([r1.reservation.keyId, r2.reservation.keyId]).size).toBe(2);

      // 完成第一条，使其 Key 的在途数归零
      const done = completeJevRequest(ctx.db, {
        id: r1.reservation.requestId,
        status: "succeeded",
        now: new Date(),
        responseModel: "jev-1.13.0",
        inputTokens: 10,
      });
      expect(done.recorded).toBe(true);

      const r3 = requireOk(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY));
      expect(r3.reservation.keyId).toBe(r1.reservation.keyId);
    } finally {
      ctx.close();
    }
  });

  it("全局容量跨入口共享：evaluate 与 dry_run 使用同一上限", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-1", concurrency: 1 }, KEY);
      expect(reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY).ok).toBe(true);
      const second = reserveJevCall(ctx.db, { purpose: "dry_run" }, KEY);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe("busy");
    } finally {
      ctx.close();
    }
  });

  it("没有可用 Key 时返回明确的配置问题，且不写账本", () => {
    const ctx = createTestDb();
    try {
      const none = reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY);
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.reason).toBe("not_configured");
      expect(requestCount(ctx.db)).toBe(0);

      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      updateJevKeySettings(ctx.db, key.id, { enabled: false }, KEY);
      const disabled = reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY);
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) expect(disabled.reason).toBe("no_key");
      expect(requestCount(ctx.db)).toBe(0);
    } finally {
      ctx.close();
    }
  });
});

describe("共享退避（AC2/AC3）", () => {
  it("共享 provider 退避期间预留返回 cooldown，不写账本", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-1" }, KEY);
      const now = new Date("2026-10-14T00:00:00.000Z");
      setJevCooldown(ctx.db, new Date(now.getTime() + 60_000), "限流", now);

      const blocked = reserveJevCall(ctx.db, { purpose: "evaluate", now }, KEY);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toBe("cooldown");
      expect(requestCount(ctx.db)).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("Key 级冷却只跳过该 Key，另一 Key 仍可服务", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 4 }, KEY);
      const a = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const b = addJevKey(ctx.db, { label: "B", apiKey: "sk-b" }, KEY);
      const now = new Date("2026-10-14T00:10:00.000Z");
      setJevKeyCooldown(
        ctx.db,
        a.id,
        new Date(now.getTime() + 60_000).toISOString(),
        now,
      );

      const reserved = requireOk(
        reserveJevCall(ctx.db, { purpose: "evaluate", now }, KEY),
      );
      expect(reserved.reservation.keyId).toBe(b.id);
    } finally {
      ctx.close();
    }
  });
});

describe("连续失败计数与禁用（AC2）", () => {
  it("连续九次失败仍启用，第十次失败自动禁用并不再分配", async () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);

      for (let i = 0; i < 9; i += 1) {
        const outcome = await callJevWithLedger(
          ctx.db,
          { purpose: "evaluate", state: "{}", questions: QUESTIONS },
          { callSystemOne: failing() as never },
        );
        expect(outcome.status).toBe("failed");
      }
      let row = getJevKey(ctx.db, key.id)!;
      expect(row.consecutiveFailures).toBe(9);
      expect(row.enabled).toBe(true);

      const tenth = await callJevWithLedger(
        ctx.db,
        { purpose: "evaluate", state: "{}", questions: QUESTIONS },
        { callSystemOne: failing() as never },
      );
      expect(tenth.status).toBe("failed");
      row = getJevKey(ctx.db, key.id)!;
      expect(row.consecutiveFailures).toBe(10);
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toContain("连续 10 次实际请求失败");

      const blocked = reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toBe("no_key");
    } finally {
      ctx.close();
    }
  });

  it("成功一次把当前 generation 的计数清零并清空 last_error", async () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const failingCall = failing();
      for (let i = 0; i < 2; i += 1) {
        await callJevWithLedger(
          ctx.db,
          { purpose: "evaluate", state: "{}", questions: QUESTIONS },
          { callSystemOne: failingCall as never },
        );
      }
      expect(getJevKey(ctx.db, key.id)!.consecutiveFailures).toBe(2);

      const outcome = await callJevWithLedger(
        ctx.db,
        { purpose: "evaluate", state: "{}", questions: QUESTIONS },
        { callSystemOne: succeeding() as never },
      );
      expect(outcome.status).toBe("succeeded");
      const row = getJevKey(ctx.db, key.id)!;
      expect(row.consecutiveFailures).toBe(0);
      expect(row.lastError).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("迟到的成功不得重新启用已禁用的 Key", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 4 }, KEY);
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);

      // 先占用一个旧 generation 的在途请求
      const reserved = requireOk(
        reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY),
      );

      const failingCall = failing();
      for (let i = 0; i < 10; i += 1) {
        await callJevWithLedger(
          ctx.db,
          { purpose: "evaluate", state: "{}", questions: QUESTIONS },
          { callSystemOne: failingCall as never },
        );
      }
      expect(getJevKey(ctx.db, key.id)!.enabled).toBe(false);

      // 旧请求迟到成功
      const late = completeJevRequest(ctx.db, {
        id: reserved.reservation.requestId,
        status: "succeeded",
        now: new Date(),
        responseModel: "jev-1.13.0",
        inputTokens: 10,
      });
      expect(late.recorded).toBe(true);

      const row = getJevKey(ctx.db, key.id)!;
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).not.toBeNull();
      expect(row.consecutiveFailures).toBe(10);
    } finally {
      ctx.close();
    }
  });

  it("手动恢复后旧 generation 的失败不改写新 generation 的计数", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 4 }, KEY);
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const reserved = requireOk(
        reserveJevCall(ctx.db, { purpose: "evaluate" }, KEY),
      );

      const failingCall = failing();
      for (let i = 0; i < 10; i += 1) {
        await callJevWithLedger(
          ctx.db,
          { purpose: "evaluate", state: "{}", questions: QUESTIONS },
          { callSystemOne: failingCall as never },
        );
      }
      expect(getJevKey(ctx.db, key.id)!.enabled).toBe(false);

      const restored = updateJevKeySettings(
        ctx.db,
        key.id,
        { enabled: true },
        KEY,
      )!;
      expect(restored.generation).toBe(2);
      expect(restored.consecutiveFailures).toBe(0);

      const late = completeJevRequest(ctx.db, {
        id: reserved.reservation.requestId,
        status: "failed",
        now: new Date(),
        errorMessage: "旧请求失败",
      });
      expect(late.recorded).toBe(true);
      const after = getJevKey(ctx.db, key.id)!;
      expect(after.consecutiveFailures).toBe(0);
      expect(after.enabled).toBe(true);
    } finally {
      ctx.close();
    }
  });
});

describe("调用账本与真实结果一次落账（AC6）", () => {
  it("同一请求重复完成只记一次，金额不翻倍", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const started = new Date("2026-10-14T00:00:00.000Z");
      const inserted = insertInFlightRequest(ctx.db, {
        keyId: key.id,
        keyLabel: key.label,
        keyGeneration: key.generation,
        purpose: "evaluate",
        requestedModel: "jev-latest",
        providerOrigin: "https://api.typesafe.ai",
        configVersion: 1,
        startedAt: started,
        leaseUntil: new Date(started.getTime() + 60_000),
      });

      const first = completeJevRequest(ctx.db, {
        id: inserted.id,
        status: "succeeded",
        now: started,
        responseModel: "jev-1.13.0",
        inputTokens: 1_000_000,
      });
      expect(first.recorded).toBe(true);
      expect(getJevRequest(ctx.db, inserted.id)!.estimatedUsdNanos).toBe(42_000_000);

      const second = completeJevRequest(ctx.db, {
        id: inserted.id,
        status: "succeeded",
        now: started,
        responseModel: "jev-1.13.0",
        inputTokens: 1_000_000,
      });
      expect(second.recorded).toBe(false);
      expect(getJevRequest(ctx.db, inserted.id)!.estimatedUsdNanos).toBe(42_000_000);
      expect(getJevUsageSummary(ctx.db).knownCostNanos).toBe(42_000_000);
    } finally {
      ctx.close();
    }
  });

  it("租约回收为 interrupted 释放容量且费用未知，迟到真实结果补写一次", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const now = new Date("2026-10-14T00:00:00.000Z");
      const inserted = insertInFlightRequest(ctx.db, {
        keyId: key.id,
        keyLabel: key.label,
        keyGeneration: key.generation,
        purpose: "evaluate",
        requestedModel: "jev-latest",
        providerOrigin: "https://api.typesafe.ai",
        configVersion: 1,
        startedAt: now,
        leaseUntil: new Date(now.getTime() + 60_000),
      });

      const reclaimed = reclaimExpiredRequestReservations(
        ctx.db,
        new Date(now.getTime() + 120_000),
      );
      expect(reclaimed).toBe(1);
      let row = getJevRequest(ctx.db, inserted.id)!;
      expect(row.status).toBe("interrupted");
      expect(row.costStatus).toBe("unknown");
      expect(row.estimatedUsdNanos).toBeNull();
      expect(countActiveInFlight(ctx.db, new Date(now.getTime() + 120_000))).toBe(0);

      const late = completeJevRequest(ctx.db, {
        id: inserted.id,
        status: "succeeded",
        now: new Date(now.getTime() + 130_000),
        responseModel: "jev-1.13.0",
        inputTokens: 1_000_000,
      });
      expect(late.recorded).toBe(true);
      row = getJevRequest(ctx.db, inserted.id)!;
      expect(row.status).toBe("succeeded");
      expect(row.estimatedUsdNanos).toBe(42_000_000);
    } finally {
      ctx.close();
    }
  });

  it("三个入口与每次重试分别记账", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-x", concurrency: 2 }, KEY);
      for (const purpose of ["evaluate", "test", "dry_run"] as const) {
        const outcome = await callJevWithLedger(
          ctx.db,
          { purpose, state: "{}", questions: QUESTIONS },
          { callSystemOne: succeeding() as never },
        );
        expect(outcome.status).toBe("succeeded");
      }
      expect(requestCount(ctx.db)).toBe(3);

      await callJevWithLedger(
        ctx.db,
        { purpose: "evaluate", state: "{}", questions: QUESTIONS },
        { callSystemOne: succeeding() as never },
      );
      expect(requestCount(ctx.db)).toBe(4);
      const purposes = (
        ctx.db.prepare("SELECT purpose FROM jev_requests").all() as Array<{
          purpose: string;
        }>
      ).map((row) => row.purpose);
      expect(purposes.sort()).toEqual(["dry_run", "evaluate", "evaluate", "test"]);
    } finally {
      ctx.close();
    }
  });

  it("非 2xx 失败仍可带用量：429 计入失败并写入共享退避与 Key 冷却", async () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const now = new Date("2026-10-14T00:00:00.000Z");
      const rateLimited = vi.fn(async () => {
        throw new JevError("Jev 返回 HTTP 429", {
          status: 429,
          retryable: true,
          retryAfterMs: 5_000,
          usage: { inputTokens: 500, outputTokens: null },
        });
      });

      const outcome = await callJevWithLedger(
        ctx.db,
        { purpose: "evaluate", state: "{}", questions: QUESTIONS },
        { callSystemOne: rateLimited as never, now: () => now },
      );
      expect(outcome.status).toBe("failed");

      const ledger = ctx.db
        .prepare(
          "SELECT input_tokens, cost_status, http_status, error_code FROM jev_requests",
        )
        .get() as {
        input_tokens: number | null;
        cost_status: string;
        http_status: number | null;
        error_code: string | null;
      };
      // 有输入用量但响应无模型，无法套用费率 -> 未知（不能显示为 $0）
      expect(ledger.input_tokens).toBe(500);
      expect(ledger.cost_status).toBe("unknown");
      expect(ledger.http_status).toBe(429);

      // 429 计入失败计数
      expect(getJevKey(ctx.db, key.id)!.consecutiveFailures).toBe(1);
      // 共享退避与 Key 冷却都被写入
      expect(getJevCooldown(ctx.db).until).not.toBeNull();
      expect(getJevKey(ctx.db, key.id)!.cooldownUntil).not.toBeNull();
    } finally {
      ctx.close();
    }
  });
});

describe("批次初筛账本与任务租约校准（AC10/AC11）", () => {
  it("batch_gate 一次调用只记一行，并关联 run/part", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-batch" }, KEY);
      const outcome = await callJevWithLedger(
        ctx.db,
        {
          purpose: "batch_gate",
          state: "{}",
          questions: QUESTIONS,
          jobId: "job-x",
          evaluationRunId: "run-1",
          batchPartId: "part-1",
        },
        { callSystemOne: succeeding() as never },
      );
      expect(outcome.status).toBe("succeeded");
      const row = ctx.db
        .prepare(
          "SELECT purpose, evaluation_run_id, batch_part_id FROM jev_requests",
        )
        .get() as {
        purpose: string;
        evaluation_run_id: string | null;
        batch_part_id: string | null;
      };
      expect(row.purpose).toBe("batch_gate");
      expect(row.evaluation_run_id).toBe("run-1");
      expect(row.batch_part_id).toBe("part-1");
      expect(requestCount(ctx.db)).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("预留事务内按实际 timeoutMs 校准任务租约（AC10）", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-lease", timeoutMs: 60_000, concurrency: 1, jobsPerRound: 1 },
        KEY,
      );
      const { id: bulletinId } = insertBulletinIfAbsent(
        ctx.db,
        makeNormalized({ sourceId: "lease-cal-1" }),
        { baseline: false },
      );
      const { id: jobId } = enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: `evaluate:${bulletinId}`,
        payload: { bulletinId },
        runAt: "2026-10-16T00:00:00.000Z",
      });
      const base = new Date("2026-10-16T00:00:00.000Z");
      const owner = "owner-cal";
      // 用很短的租约领取，模拟「claim 时用了旧超时，发送前管理员又增大 timeout」。
      const claimed = claimJob(ctx.db, owner, 1_000, base, "evaluate");
      expect(claimed?.id).toBe(jobId);

      const outcome = await callJevWithLedger(
        ctx.db,
        {
          purpose: "evaluate",
          state: "{}",
          questions: QUESTIONS,
          jobId,
          jobOwner: owner,
        },
        { callSystemOne: succeeding() as never, now: () => base },
      );
      expect(outcome.status).toBe("succeeded");
      const leaseUntil = Date.parse(getJob(ctx.db, jobId)!.leaseUntil!);
      expect(leaseUntil).toBeGreaterThanOrEqual(
        base.getTime() + 60_000 + 30_000,
      );
    } finally {
      ctx.close();
    }
  });

  it("失去 owner 时返回 lease_lost，不发请求、不写账本（AC10）", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-lease-lost" }, KEY);
      const callSystemOne = succeeding();
      const outcome = await callJevWithLedger(
        ctx.db,
        {
          purpose: "evaluate",
          state: "{}",
          questions: QUESTIONS,
          jobId: "missing-job",
          jobOwner: "owner-x",
        },
        { callSystemOne: callSystemOne as never },
      );
      expect(outcome.status).toBe("blocked");
      if (outcome.status === "blocked") {
        expect(outcome.block.reason).toBe("lease_lost");
      }
      expect(callSystemOne).not.toHaveBeenCalled();
      expect(requestCount(ctx.db)).toBe(0);
    } finally {
      ctx.close();
    }
  });
});
