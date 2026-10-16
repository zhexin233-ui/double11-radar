import { describe, expect, it } from "vitest";
import {
  excludeBatchPart,
  expandBatchPart,
  getBatchPart,
  getProcessing,
  insertBatchPart,
  insertEvaluationRun,
  insertProcessing,
  listProcessingByPart,
  updateProcessing,
} from "@/lib/db/repos/evaluation-runs";
import { createTestDb } from "../helpers/db";

/**
 * 三模式 run / 子批 / 成员处理记录的原子性与幂等性（AC3/AC6/AC11）。
 */

const NOW = "2026-10-16T00:00:00.000Z";

function seedRun(ctx: ReturnType<typeof createTestDb>, mode: "batch_gate" | "individual" = "batch_gate") {
  const runId = "run-1";
  insertEvaluationRun(ctx.db, {
    id: runId,
    sourceNs: "feed:haodan",
    evaluationMode: mode,
    strategyConfigVersion: 1,
    regexRules: mode === "batch_gate" ? null : ["抽纸"],
    needSnapshots:
      mode === "batch_gate"
        ? [{ id: "n1", name: "抽纸", note: "", enabled: true, version: 1 }]
        : null,
    createdAt: NOW,
  });
  return runId;
}

describe("批次子批终态唯一（AC3/AC6）", () => {
  it("合法全否只从 pending 进入 excluded 一次，并把成员置 filtered", () => {
    const ctx = createTestDb();
    try {
      const runId = seedRun(ctx);
      insertBatchPart(ctx.db, { id: "part-1", runId, ordinal: 0, createdAt: NOW });
      insertProcessing(ctx.db, { bulletinId: "b1", runId, batchPartId: "part-1", position: 0, createdAt: NOW });
      insertProcessing(ctx.db, { bulletinId: "b2", runId, batchPartId: "part-1", position: 1, createdAt: NOW });

      const first = excludeBatchPart(ctx.db, {
        partId: "part-1",
        gateRequestId: "req-1",
        gateResult: "not_matched",
        reason: "由批次预筛判定，未进行逐条 JEV 判断",
        now: NOW,
      });
      expect(first).toBe(true);
      const part = getBatchPart(ctx.db, "part-1")!;
      expect(part.state).toBe("excluded");
      expect(part.gateRequestId).toBe("req-1");
      expect(part.gateResult).toBe("not_matched");
      expect(
        listProcessingByPart(ctx.db, "part-1").every(
          (row) => row.stage === "filtered" && row.screeningSource === "batch_gate",
        ),
      ).toBe(true);

      // 重复执行（迟到门控）不再改变终态。
      expect(
        excludeBatchPart(ctx.db, {
          partId: "part-1",
          gateRequestId: "req-2",
          gateResult: "not_matched",
          reason: "重复",
          now: NOW,
        }),
      ).toBe(false);
      expect(getBatchPart(ctx.db, "part-1")!.gateRequestId).toBe("req-1");
    } finally {
      ctx.close();
    }
  });

  it("展开与全否互斥：已 excluded 的 part 不能被展开", () => {
    const ctx = createTestDb();
    try {
      const runId = seedRun(ctx);
      insertBatchPart(ctx.db, { id: "part-1", runId, ordinal: 0, createdAt: NOW });
      insertProcessing(ctx.db, { bulletinId: "b1", runId, batchPartId: "part-1", position: 0, createdAt: NOW });

      excludeBatchPart(ctx.db, {
        partId: "part-1",
        gateRequestId: null,
        gateResult: "not_matched",
        reason: "全否",
        now: NOW,
      });
      const expanded = expandBatchPart(ctx.db, {
        partId: "part-1",
        gateRequestId: null,
        gateResult: "matched",
        fallbackReason: null,
        now: NOW,
      });
      expect(expanded).toBe(false);
      expect(getBatchPart(ctx.db, "part-1")!.state).toBe("excluded");
    } finally {
      ctx.close();
    }
  });

  it("展开把成员置 ready 并记录回退原因", () => {
    const ctx = createTestDb();
    try {
      const runId = seedRun(ctx);
      insertBatchPart(ctx.db, { id: "part-1", runId, ordinal: 0, createdAt: NOW });
      insertProcessing(ctx.db, { bulletinId: "b1", runId, batchPartId: "part-1", position: 0, createdAt: NOW });

      const changed = expandBatchPart(ctx.db, {
        partId: "part-1",
        gateRequestId: "req-x",
        gateResult: null,
        fallbackReason: "批次初筛失败，已转逐条判断",
        now: NOW,
      });
      expect(changed).toBe(true);
      const row = getProcessing(ctx.db, "b1")!;
      expect(row.stage).toBe("ready");
      expect(row.screeningReason).toContain("已转逐条判断");
    } finally {
      ctx.close();
    }
  });
});

describe("成员处理阶段更新（AC7/AC8）", () => {
  it("更新保留未提交字段，并支持正则来源与命中规则序号", () => {
    const ctx = createTestDb();
    try {
      const runId = seedRun(ctx, "individual");
      insertProcessing(ctx.db, { bulletinId: "b1", runId, batchPartId: null, position: 0, createdAt: NOW });

      updateProcessing(
        ctx.db,
        "b1",
        {
          stage: "filtered",
          screeningSource: "regex_gate",
          screeningReason: "正则规则未匹配，未调用 JEV",
          matchedRuleIndex: null,
        },
        NOW,
      );
      const filtered = getProcessing(ctx.db, "b1")!;
      expect(filtered.stage).toBe("filtered");
      expect(filtered.screeningSource).toBe("regex_gate");
      expect(filtered.matchedRuleIndex).toBeNull();

      // 只改阶段时不应清掉来源。
      updateProcessing(ctx.db, "b1", { stage: "evaluated" }, NOW);
      const evaluated = getProcessing(ctx.db, "b1")!;
      expect(evaluated.stage).toBe("evaluated");
      expect(evaluated.screeningSource).toBe("regex_gate");
    } finally {
      ctx.close();
    }
  });
});
