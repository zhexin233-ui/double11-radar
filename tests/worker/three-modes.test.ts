import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { loadEnv } from "@/lib/env";
import {
  getBulletinDisplayStatus,
  insertBulletinIfAbsent,
} from "@/lib/db/repos/bulletins";
import { enqueueJob, getJob } from "@/lib/db/repos/jobs";
import { createNeed, listEnabledNeeds } from "@/lib/db/repos/needs";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import {
  getBatchPart,
  getProcessing,
  insertBatchPart,
  insertEvaluationRun,
  insertProcessing,
} from "@/lib/db/repos/evaluation-runs";
import { getJevConfigView, saveJevConfig } from "@/lib/service/config";
import { questionIdForNeed } from "@/lib/jev/prompt";
import { BATCH_GATE_QUESTION_ID } from "@/lib/jev/batch-prompt";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import type { RegexRunner } from "@/lib/service/regex-runner";
import type { EvaluationMode, NeedSnapshot } from "@/lib/domain/types";

/**
 * 三种判断模式的调度行为（AC1/AC3/AC4/AC5/AC6/AC7/AC8）。
 *
 * 全部模型调用经注入的假传输层完成，不做真实网络请求；正则执行使用 fake runner。
 */

const KEY = testKey();
const ENV = loadEnv();
const NOW = "2026-10-16T00:00:00.000Z";

type Ctx = ReturnType<typeof createTestDb>;

function countRows(db: Ctx["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function seedBulletin(ctx: Ctx, sourceId: string): string {
  return insertBulletinIfAbsent(
    ctx.db,
    makeNormalized({ sourceId, title: `线报 ${sourceId}`, content: "9.9 元包邮" }),
    { baseline: false },
  ).id;
}

function snapshots(ctx: Ctx): NeedSnapshot[] {
  return listEnabledNeeds(ctx.db).map((need) => ({
    id: need.id,
    name: need.name,
    note: need.note,
    enabled: need.enabled,
    version: need.version,
  }));
}

interface SeedRunOptions {
  mode: EvaluationMode;
  bulletinIds: string[];
  regexRules?: string[] | null;
  needSnapshots?: NeedSnapshot[] | null;
  withPart?: boolean;
}

function seedRun(ctx: Ctx, options: SeedRunOptions): {
  runId: string;
  partId: string | null;
} {
  const runId = randomUUID();
  insertEvaluationRun(ctx.db, {
    id: runId,
    sourceNs: "feed:haodan",
    evaluationMode: options.mode,
    strategyConfigVersion: getJevConfigView(ctx.db).version,
    regexRules: options.regexRules ?? null,
    needSnapshots: options.needSnapshots ?? null,
    createdAt: NOW,
  });
  const partId = options.withPart ? randomUUID() : null;
  if (partId) {
    insertBatchPart(ctx.db, { id: partId, runId, ordinal: 0, createdAt: NOW });
  }
  options.bulletinIds.forEach((bulletinId, index) => {
    insertProcessing(ctx.db, {
      bulletinId,
      runId,
      batchPartId: partId,
      position: index,
      createdAt: NOW,
    });
  });
  if (partId) {
    enqueueJob(ctx.db, {
      kind: "screen_batch",
      payloadKey: `screen_batch:${partId}`,
      payload: { partId, evaluationRunId: runId },
      runAt: NOW,
    });
  } else {
    for (const bulletinId of options.bulletinIds) {
      enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: `evaluate:${bulletinId}`,
        payload: { bulletinId, evaluationRunId: runId },
        runAt: NOW,
      });
    }
  }
  return { runId, partId };
}

type MatchOutcome = Awaited<ReturnType<RegexRunner["match"]>>;

function fakeRunner(outcome: MatchOutcome): RegexRunner {
  return {
    validate: vi.fn(async () => ({ ok: true as const })),
    match: vi.fn(async () => outcome),
    dispose: vi.fn(),
  };
}

describe("逐条模式（AC1）", () => {
  it("N 条新线报发 N 次请求，每次携带全部启用需求", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      const makeup = createNeed(ctx.db, { name: "卸妆膏" });
      saveJevConfig(ctx.db, { apiKey: "sk-individual", jobsPerRound: 10 }, KEY);

      const ids = [seedBulletin(ctx, "i1"), seedBulletin(ctx, "i2")];
      seedRun(ctx, { mode: "individual", bulletinIds: ids });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              { type: "choice", choice: "not_matched" },
            ]),
          ),
        }),
      );
      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: calls as never,
      });

      expect(calls).toHaveBeenCalledTimes(2);
      const expectedQuestions = [questionIdForNeed(paper.id), questionIdForNeed(makeup.id)].sort();
      for (const call of calls.mock.calls) {
        const request = call[1] as { questions: Record<string, unknown> };
        expect(Object.keys(request.questions).sort()).toEqual(expectedQuestions);
      }
      expect(result.processed).toBe(2);
      expect(getBulletinDisplayStatus(ctx.db, ids[0])).toBe("not_matched");
      expect(countRows(ctx.db, "notifications")).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("低概率 matched 降为待确认，不通知且调用次数不变（同策略）", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-individual-low", jobsPerRound: 10 }, KEY);
      const id = seedBulletin(ctx, "i-low");
      seedRun(ctx, { mode: "individual", bulletinIds: [id] });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((q) => [
              q,
              {
                type: "choice",
                choice: "matched",
                probabilities: { matched: 0.52, not_matched: 0.15, uncertain: 0.33 },
              },
            ]),
          ),
        }),
      );
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: calls as never });

      // 仍然只发一次请求，不因降级而额外调用或重判。
      expect(calls).toHaveBeenCalledTimes(1);
      const [evaluation] = listEvaluationsByBulletin(ctx.db, id);
      expect(evaluation.result).toBe("uncertain");
      expect(evaluation.modelResult).toBe("matched");
      expect(evaluation.decisionReason).toBe("matched_probability_below_threshold");
      expect(countRows(ctx.db, "notifications")).toBe(0);
      expect(getBulletinDisplayStatus(ctx.db, id)).toBe("uncertain");
    } finally {
      ctx.close();
    }
  });
});

describe("批次预筛模式（AC3/AC4/AC5）", () => {
  it("合法全否只发一次初筛，成员结束等待且不通知", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-batch", evaluationMode: "batch_gate", jobsPerRound: 10 },
        KEY,
      );
      const ids = [seedBulletin(ctx, "b1"), seedBulletin(ctx, "b2"), seedBulletin(ctx, "b3")];
      const { partId } = seedRun(ctx, {
        mode: "batch_gate",
        bulletinIds: ids,
        needSnapshots: snapshots(ctx),
        withPart: true,
      });

      const calls = vi.fn(async () => ({
        answers: {
          [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "not_matched" },
        },
      }));
      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: calls as never,
      });

      expect(calls).toHaveBeenCalledTimes(1);
      const part = getBatchPart(ctx.db, partId!)!;
      expect(part.state).toBe("excluded");
      expect(part.gateResult).toBe("not_matched");
      for (const id of ids) {
        const processing = getProcessing(ctx.db, id)!;
        expect(processing.stage).toBe("filtered");
        expect(processing.screeningSource).toBe("batch_gate");
        expect(processing.screeningReason).toContain("批次预筛");
        expect(listEvaluationsByBulletin(ctx.db, id)).toHaveLength(0);
        expect(getBulletinDisplayStatus(ctx.db, id)).toBe("not_matched");
      }
      expect(countRows(ctx.db, "notifications")).toBe(0);
      expect(result.gated).toBe(1);
      expect(result.filtered).toBe(3);
      // 一次初筛只记一行账本，不按成员倍增费用。
      expect(countRows(ctx.db, "jev_requests")).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("命中或可疑后全批所有成员逐条判断（共 N+1 次）", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-batch", evaluationMode: "batch_gate", jobsPerRound: 10 },
        KEY,
      );
      const ids = [seedBulletin(ctx, "g1"), seedBulletin(ctx, "g2"), seedBulletin(ctx, "g3")];
      seedRun(ctx, {
        mode: "batch_gate",
        bulletinIds: ids,
        needSnapshots: snapshots(ctx),
        withPart: true,
      });

      const gateCalls: number[] = [];
      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => {
          if (BATCH_GATE_QUESTION_ID in request.questions) {
            gateCalls.push(1);
            return {
              answers: {
                [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "uncertain" },
              },
            };
          }
          // 展开后的逐条判断：全部命中。
          return {
            answers: {
              [questionIdForNeed(paper.id)]: {
                type: "choice",
                choice: "matched",
                probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
              },
            },
          };
        },
      );
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: calls as never });

      expect(gateCalls).toHaveLength(1);
      // 一次初筛 + 3 次逐条 = 4 次。
      expect(calls).toHaveBeenCalledTimes(4);
      for (const id of ids) {
        expect(getProcessing(ctx.db, id)!.stage).toBe("evaluated");
        expect(listEvaluationsByBulletin(ctx.db, id)).toHaveLength(1);
      }
      // 每个成员各自命中一次 → 3 条通知。
      expect(countRows(ctx.db, "notifications")).toBe(3);
      expect(countRows(ctx.db, "jev_requests")).toBe(4);
    } finally {
      ctx.close();
    }
  });

  it("非法初筛答案按一次失败落账并回退全批逐条，不造成整批未命中（AC5）", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-batch", evaluationMode: "batch_gate", jobsPerRound: 10 },
        KEY,
      );
      const ids = [seedBulletin(ctx, "x1"), seedBulletin(ctx, "x2")];
      const { partId } = seedRun(ctx, {
        mode: "batch_gate",
        bulletinIds: ids,
        needSnapshots: snapshots(ctx),
        withPart: true,
      });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => {
          if (BATCH_GATE_QUESTION_ID in request.questions) {
            return { answers: { [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "maybe" } } };
          }
          return {
            answers: {
              [questionIdForNeed(paper.id)]: { type: "choice", choice: "not_matched" },
            },
          };
        },
      );
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: calls as never });

      expect(calls).toHaveBeenCalledTimes(3);
      const part = getBatchPart(ctx.db, partId!)!;
      expect(part.state).toBe("expanded");
      expect(part.fallbackReason).toContain("已转逐条判断");
      for (const id of ids) {
        expect(getProcessing(ctx.db, id)!.stage).toBe("evaluated");
      }
      // 非法答案计一次真实失败，但仍保留 response/usage 关联。
      const ledger = ctx.db
        .prepare("SELECT status, error_code FROM jev_requests ORDER BY started_at ASC")
        .all() as Array<{ status: string; error_code: string | null }>;
      expect(ledger[0].status).toBe("failed");
      expect(ledger[0].error_code).toBe("invalid_response");
    } finally {
      ctx.close();
    }
  });

  it("无可用 Key 时初筛保持 pending，不用回退绕过阻塞（AC5）", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { evaluationMode: "batch_gate", jobsPerRound: 10 }, KEY);
      const ids = [seedBulletin(ctx, "k1"), seedBulletin(ctx, "k2")];
      const { partId } = seedRun(ctx, {
        mode: "batch_gate",
        bulletinIds: ids,
        needSnapshots: snapshots(ctx),
        withPart: true,
      });

      const calls = vi.fn();
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: calls as never });

      expect(calls).not.toHaveBeenCalled();
      expect(getBatchPart(ctx.db, partId!)!.state).toBe("pending");
      for (const id of ids) expect(getProcessing(ctx.db, id)!.stage).toBe("pending");
      expect(countRows(ctx.db, "jev_requests")).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("初筛返回期间连接语义变化时否定结果不作数，转逐条（AC5）", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-batch", evaluationMode: "batch_gate", jobsPerRound: 10 },
        KEY,
      );
      const ids = [seedBulletin(ctx, "s1"), seedBulletin(ctx, "s2")];
      const { partId } = seedRun(ctx, {
        mode: "batch_gate",
        bulletinIds: ids,
        needSnapshots: snapshots(ctx),
        withPart: true,
      });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => {
          if (BATCH_GATE_QUESTION_ID in request.questions) {
            // 模拟门控返回前后管理员改了模型标识。
            saveJevConfig(ctx.db, { model: "jev-changed" }, KEY);
            return {
              answers: {
                [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "not_matched" },
              },
            };
          }
          return {
            answers: {
              [questionIdForNeed(paper.id)]: { type: "choice", choice: "not_matched" },
            },
          };
        },
      );
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: calls as never });

      const part = getBatchPart(ctx.db, partId!)!;
      expect(part.state).toBe("expanded");
      expect(part.fallbackReason).toContain("模型");
      for (const id of ids) expect(getProcessing(ctx.db, id)!.stage).toBe("evaluated");
    } finally {
      ctx.close();
    }
  });
});

describe("正则预筛模式（AC7/AC8）", () => {
  it("正则命中才调用 JEV，并记录命中规则序号", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-regex", jobsPerRound: 10 }, KEY);
      const id = seedBulletin(ctx, "r1");
      seedRun(ctx, { mode: "regex_gate", bulletinIds: [id], regexRules: ["抽纸|软抽"] });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((q) => [
              q,
              { type: "choice", choice: "not_matched" },
            ]),
          ),
        }),
      );
      await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: calls as never,
        regexRunner: fakeRunner({ ok: true, matched: true, matchedRuleIndex: 0 }),
      });

      expect(calls).toHaveBeenCalledTimes(1);
      const processing = getProcessing(ctx.db, id)!;
      expect(processing.stage).toBe("evaluated");
      expect(processing.screeningSource).toBe("regex_gate");
      expect(processing.matchedRuleIndex).toBe(0);
      expect(questionIdForNeed(paper.id)).toBeTruthy();
    } finally {
      ctx.close();
    }
  });

  it("正则未匹配不发请求，可查过滤来源且不伪造概率", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-regex", jobsPerRound: 10 }, KEY);
      const id = seedBulletin(ctx, "r2");
      seedRun(ctx, { mode: "regex_gate", bulletinIds: [id], regexRules: ["抽纸"] });

      const calls = vi.fn();
      await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: calls as never,
        regexRunner: fakeRunner({ ok: true, matched: false, matchedRuleIndex: null }),
      });

      expect(calls).not.toHaveBeenCalled();
      const processing = getProcessing(ctx.db, id)!;
      expect(processing.stage).toBe("filtered");
      expect(processing.screeningSource).toBe("regex_gate");
      expect(listEvaluationsByBulletin(ctx.db, id)).toHaveLength(0);
      expect(getBulletinDisplayStatus(ctx.db, id)).toBe("not_matched");
      expect(countRows(ctx.db, "jev_requests")).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("正则执行异常回退逐条并记录原因，不静默过滤（AC8）", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-regex", jobsPerRound: 10 }, KEY);
      const id = seedBulletin(ctx, "r3");
      seedRun(ctx, { mode: "regex_gate", bulletinIds: [id], regexRules: ["("] });

      const calls = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((q) => [
              q,
              {
                type: "choice",
                choice: "matched",
                probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
              },
            ]),
          ),
        }),
      );
      await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: calls as never,
        regexRunner: fakeRunner({ ok: false, fallback: true, error: "模拟超时" }),
      });

      expect(calls).toHaveBeenCalledTimes(1);
      const processing = getProcessing(ctx.db, id)!;
      expect(processing.screeningReason).toContain("回退逐条");
      expect(processing.stage).toBe("evaluated");
      expect(countRows(ctx.db, "notifications")).toBe(1);
      expect(questionIdForNeed(paper.id)).toBeTruthy();
    } finally {
      ctx.close();
    }
  });
});
