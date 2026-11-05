import { describe, expect, it, vi } from "vitest";
import samples from "../fixtures/need-offer-samples.json";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { loadEnv } from "@/lib/env";
import { createNeed } from "@/lib/db/repos/needs";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { saveJevConfig } from "@/lib/service/config";
import { runJevDryRun } from "@/lib/service/dry-run";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import type { callSystemOne } from "@/lib/jev/client";

// 明确按人工两维标签各自构造答案，绝不自动克隆相关性为促销通过。
// 旧分数仅用于离线证明取消数值门槛；真实双题分数可能改变。
function labeledAnswer(choice: string, matchedProbability: number) {
  return { type: "choice", choice, probabilities: {
    matched: choice === "matched" ? matchedProbability : 0.1,
    not_matched: choice === "not_matched" ? 0.8 : choice === "matched" ? (1 - matchedProbability) * 0.6 : 0.1,
    uncertain: choice === "uncertain" ? 0.8 : choice === "matched" ? (1 - matchedProbability) * 0.4 : 0.1,
  } };
}

describe("人工固定样本mock回放（只证明构造、决策与副作用；未验证真实模型语义）", () => {
  it.each(samples)("$id：人工相关性=$labels.relevance，促销=$labels.offer，业务=$expected", async sample => {
    const ctx = createTestDb();
    try {
      const need = createNeed(ctx.db, sample.need);
      saveJevConfig(ctx.db, { apiKey: "sk-offline-replay" }, testKey());
      const transport: typeof callSystemOne = vi.fn(async (_config, request) => ({
        model: "offline-mock", upstreamRequestId: null, httpStatus: 200, usage: { inputTokens: 100, outputTokens: 10 },
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
          expect(question).toMatchObject({ instructions: expect.stringContaining(sample.need.name) });
          if (sample.need.note) expect(question).toMatchObject({ instructions: expect.stringContaining(sample.need.note) });
          const state = JSON.parse(request.state);
          expect(state.线报标题).toBe(sample.title);
          expect(state.正文).toBe(sample.content);
          const label = id.startsWith("need_") ? sample.labels.relevance : sample.labels.offer;
          return [id, labeledAnswer(label, sample.legacyMatchedProbability ?? 0.76)];
        })),
      }));
      const dry = await runJevDryRun(ctx.db, { title: sample.title, content: sample.content, mockNeeds: [sample.need] }, { callSystemOne: transport });
      expect(dry.results).toHaveLength(1);
      expect(dry.results[0].result).toBe(sample.expected);
      expect(dry.results[0].modelResult).toBe(sample.labels.relevance);
      expect(dry.results[0].offerAssessment.result).toBe(sample.labels.offer);
      for (const table of ["evaluations", "notifications", "deliveries", "jobs"]) {
        expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 });
      }
      expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM jev_requests").get()).toEqual({ c: 1 });

      const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceId: sample.id, title: sample.title, content: sample.content }), { baseline: false }).id;
      enqueueJob(ctx.db, { kind: "evaluate", payloadKey: `evaluate:${bulletinId}`, payload: { bulletinId } });
      await runEvaluatorOnce(ctx.db, loadEnv(), { callSystemOne: transport });
      const rows = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(rows).toHaveLength(1);
      expect(rows[0].needId).toBe(need.id);
      expect(rows[0].result).toBe(dry.results[0].result);
      expect(rows[0].decisionReason).toBe(dry.results[0].decisionReason);
      expect(rows[0].offerAssessment?.result).toBe(dry.results[0].offerAssessment.result);
      expect(rows[0].attempts).toBe(1);
      expect(rows[0].error).toBeNull();
      expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM notifications").get()).toEqual({ c: sample.expected === "matched" ? 1 : 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM jev_requests").get()).toEqual({ c: 2 });
    } finally { ctx.close(); }
  });
});
