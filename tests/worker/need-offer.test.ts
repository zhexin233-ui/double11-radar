import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { loadEnv } from "@/lib/env";
import { createNeed, updateNeed } from "@/lib/db/repos/needs";
import { enqueueJob, getJob } from "@/lib/db/repos/jobs";
import { countBulletinsByDisplayStatus, getBulletinDisplayStatus, insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin, upsertEvaluation } from "@/lib/db/repos/evaluations";
import { getNotificationByBulletin, createNotificationIfAbsent } from "@/lib/db/repos/notifications";
import { getProcessing, insertEvaluationRun, insertProcessing } from "@/lib/db/repos/evaluation-runs";
import { listBulletinDetails } from "@/lib/service/bulletins";
import { runJevDryRun } from "@/lib/service/dry-run";
import { saveJevConfig, saveNotifyConfig } from "@/lib/service/config";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import { questionIdForNeed, offerQuestionIdForNeed } from "@/lib/jev/prompt";
import type { callSystemOne } from "@/lib/jev/client";

const ENV = loadEnv();
const confirmedRelevance = { type: "choice", choice: "matched", probabilities: { matched: 0.76, not_matched: 0.14, uncertain: 0.1 } };
const confirmedOffer = { type: "choice", choice: "matched", probabilities: { matched: 0.69, not_matched: 0.21, uncertain: 0.1 } };

function seed(ctx: ReturnType<typeof createTestDb>, sourceId: string, withProcessing = false) {
  const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceId }), { baseline: false }).id;
  if (withProcessing) {
    const createdAt = new Date().toISOString();
    insertEvaluationRun(ctx.db, { id: `run-${sourceId}`, sourceNs: "feed:haodan", evaluationMode: "individual", strategyConfigVersion: 1, regexRules: null, needSnapshots: null, createdAt });
    insertProcessing(ctx.db, { bulletinId, runId: `run-${sourceId}`, position: 0, batchPartId: null, createdAt });
  }
  const jobId = enqueueJob(ctx.db, { kind: "evaluate", payloadKey: `evaluate:${bulletinId}`, payload: { bulletinId, ...(withProcessing ? { evaluationRunId: `run-${sourceId}` } : {}) } }).id;
  return { bulletinId, jobId };
}

function response(answers: Record<string, unknown>) {
  return { answers, model: "offline-mock", usage: { inputTokens: 123, outputTokens: 12 }, upstreamRequestId: null, httpStatus: 200 };
}

describe("双题流水线与混合状态（离线mock，仅验证控制流）", () => {
  it("缺促销题只失败该需求；有效需求仍通知；N行一次账本、解析失败完成且不重判", async () => {
    const ctx = createTestDb();
    try {
      const valid = createNeed(ctx.db, { name: "安踏" });
      const missing = createNeed(ctx.db, { name: "吕洗发水" });
      const negative = createNeed(ctx.db, { name: "蓝月亮" });
      saveJevConfig(ctx.db, { apiKey: "sk-offline" }, testKey());
      const { bulletinId, jobId } = seed(ctx, "partial");
      const transport = vi.fn<typeof callSystemOne>(async () => response({
        [questionIdForNeed(valid.id)]: confirmedRelevance,
        [offerQuestionIdForNeed(valid.id)]: confirmedOffer,
        [questionIdForNeed(missing.id)]: confirmedRelevance,
        // 故意缺 offer，不能让否定或有效的相关性掩盖缺题。
        [questionIdForNeed(negative.id)]: { choice: "not_matched" },
        [offerQuestionIdForNeed(negative.id)]: { choice: "not_matched" },
      }));
      const result = await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: transport });
      expect(result.matched).toBe(1);
      const rows = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.attempts === 1)).toBe(true);
      expect(new Set(rows.map(r => r.jevRequestId)).size).toBe(1);
      const missingRow = rows.find(r => r.needId === missing.id)!;
      expect(missingRow).toMatchObject({ result: "failed", modelResult: "matched", decisionReason: "offer_parse_failed" });
      expect(missingRow.offerAssessment).toMatchObject({ result: "failed", rawAnswer: null, probabilities: null });
      expect(missingRow.error).toContain("该需求促销");
      expect(JSON.parse(getNotificationByBulletin(ctx.db, bulletinId)!.payload).needs).toEqual(["安踏"]);
      expect(ctx.db.prepare("SELECT COUNT(*) c, SUM(input_tokens) tokens FROM jev_requests").get()).toEqual({ c: 1, tokens: 123 });
      expect(getJob(ctx.db, jobId)?.status).toBe("succeeded");
      expect(ctx.db.prepare("SELECT status FROM jev_requests").get()).toEqual({ status: "succeeded" });
      expect(ctx.db.prepare("SELECT consecutive_failures FROM jev_api_keys").get()).toEqual({ consecutive_failures: 0 });
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: transport });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { ctx.close(); }
  });

  it("失败优先于不确定，worker／首页／列表／筛选total／详情一致，覆盖无evaluation任务失败和基线", async () => {
    const ctx = createTestDb();
    try {
      const uncertain = createNeed(ctx.db, { name: "安踏" });
      const failed = createNeed(ctx.db, { name: "吕" });
      saveJevConfig(ctx.db, { apiKey: "sk-offline" }, testKey());
      const { bulletinId } = seed(ctx, "mixed", true);
      const transport: typeof callSystemOne = async () => response({
        [questionIdForNeed(uncertain.id)]: { choice: "uncertain" },
        [offerQuestionIdForNeed(uncertain.id)]: confirmedOffer,
        [questionIdForNeed(failed.id)]: confirmedRelevance,
      });
      const round = await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: transport });
      expect(round.failed).toBe(1);
      expect(round.uncertain).toBe(0);
      expect(getProcessing(ctx.db, bulletinId)?.stage).toBe("failed");
      expect(getBulletinDisplayStatus(ctx.db, bulletinId)).toBe("failed");
      const page = listBulletinDetails(ctx.db, { status: "failed", baseline: false, limit: 1 });
      expect(page.total).toBe(1);
      expect(page.items[0].status).toBe("failed");
      expect(countBulletinsByDisplayStatus(ctx.db)).toMatchObject({ failed: 1, uncertain: 0 });
      const jobOnly = seed(ctx, "failed-job-only");
      ctx.db.prepare("UPDATE jobs SET status = 'dead', last_error = '网络故障' WHERE id = ?").run(jobOnly.jobId);
      const baselineId = insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceId: "baseline" }), { baseline: true }).id;
      upsertEvaluation(ctx.db, { bulletinId: baselineId, needId: "old", needName: "旧", needNote: "", needVersion: 1, configVersion: 1, ruleVersion: "old", result: "matched" });
      expect(countBulletinsByDisplayStatus(ctx.db)).toMatchObject({ failed: 2, matched: 0, baseline: 1 });
      expect(listBulletinDetails(ctx.db, { status: "failed", baseline: false, limit: 1 }).total).toBe(2);
    } finally { ctx.close(); }
  });

  it("新规则命中不重写已存在的历史通知、不补建投递", async () => {
    const ctx = createTestDb();
    try {
      const need = createNeed(ctx.db, { name: "安踏" });
      saveJevConfig(ctx.db, { apiKey: "sk-offline" }, testKey());
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "offline-device" } }, testKey());
      const { bulletinId } = seed(ctx, "old-notification");
      const old = createNotificationIfAbsent(ctx.db, bulletinId, { needs: ["旧需求"], explanation: "历史通知" }).notification;
      const transport: typeof callSystemOne = async () => response({ [questionIdForNeed(need.id)]: confirmedRelevance, [offerQuestionIdForNeed(need.id)]: confirmedOffer });
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: transport });
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0].result).toBe("matched");
      expect(getNotificationByBulletin(ctx.db, bulletinId)).toEqual(old);
      expect(ctx.db.prepare("SELECT COUNT(*) c FROM deliveries").get()).toEqual({ c: 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) c FROM notification_dedup").get()).toEqual({ c: 0 });
    } finally { ctx.close(); }
  });

  it("13需求在同一次试判中形成26题和13行；单题促销失败保留有效相关性且零业务表写入", async () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-offline" }, testKey());
      const transport = vi.fn<typeof callSystemOne>(async (_config, request) => {
        expect(Object.keys(request.questions)).toHaveLength(26);
        return response(Object.fromEntries(Object.keys(request.questions).map(id => [id,
          id === "offer_mock-2" ? { type: "score", choice: "matched" } : id.startsWith("need_") ? confirmedRelevance : confirmedOffer,
        ])));
      });
      const result = await runJevDryRun(ctx.db, { title: "人工多题协议mock", mockNeeds: Array.from({ length: 13 }, (_, i) => ({ name: `人工需求${i}`, note: "" })) }, { callSystemOne: transport });
      expect(result.results).toHaveLength(13);
      expect(result.results[1]).toMatchObject({ result: "failed", modelResult: "matched", decisionReason: "offer_parse_failed", offerAssessment: { result: "failed" } });
      expect(result.results.filter(r => r.result === "matched")).toHaveLength(12);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(ctx.db.prepare("SELECT COUNT(*) c FROM jev_requests").get()).toEqual({ c: 1 });
      for (const table of ["evaluations", "notifications", "deliveries", "jobs"]) {
        expect(ctx.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).toEqual({ c: 0 });
      }
    } finally { ctx.close(); }
  });

  it("批次run使用采集时需求备注快照，两题都不受执行时改名备注影响", async () => {
    const ctx = createTestDb();
    try {
      const need = createNeed(ctx.db, { name: "安踏", note: "只买鞋" });
      saveJevConfig(ctx.db, { apiKey: "sk-offline" }, testKey());
      const createdAt = new Date().toISOString();
      insertEvaluationRun(ctx.db, { id: "snapshot-run", sourceNs: "feed:haodan", evaluationMode: "batch_gate", strategyConfigVersion: 1, regexRules: null, needSnapshots: [{ id: need.id, name: need.name, note: need.note, version: need.version, enabled: true }], createdAt });
      const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceId: "snapshot" }), { baseline: false }).id;
      insertProcessing(ctx.db, { bulletinId, runId: "snapshot-run", batchPartId: null, position: 0, createdAt });
      enqueueJob(ctx.db, { kind: "evaluate", payloadKey: `evaluate:${bulletinId}`, payload: { bulletinId, evaluationRunId: "snapshot-run" } });
      updateNeed(ctx.db, need.id, { name: "其他品牌", note: "只买外套" });
      const transport: typeof callSystemOne = async (_config, request) => {
        for (const question of Object.values(request.questions)) {
          expect(question).toMatchObject({ instructions: expect.stringContaining("用户购买需求：安踏") });
          expect(question).toMatchObject({ instructions: expect.stringContaining("只买鞋") });
          expect(question).not.toMatchObject({ instructions: expect.stringContaining("用户购买需求：其他品牌") });
        }
        return response({ [questionIdForNeed(need.id)]: confirmedRelevance, [offerQuestionIdForNeed(need.id)]: confirmedOffer });
      };
      await runEvaluatorOnce(ctx.db, ENV, { callSystemOne: transport });
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0]).toMatchObject({ needName: "安踏", needNote: "只买鞋", needVersion: 1, result: "matched" });
    } finally { ctx.close(); }
  });
});
