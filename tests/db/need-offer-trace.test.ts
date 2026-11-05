import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { migrate } from "@/lib/db/migrate";
import { migrations } from "@/lib/db/migrations";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin, upsertEvaluation } from "@/lib/db/repos/evaluations";
import { NEED_OFFER_CONFIRMATION_POLICY } from "@/lib/jev/match-policy";
import type { OfferAssessment } from "@/lib/domain/types";

const offer: OfferAssessment = {
  questionId: "offer_n1", result: "matched", probabilities: { matched: 0.69 },
  confidence: 1.2, rawAnswer: '{"choice":"matched","probabilities":{"matched":0.69}}', error: null,
};

describe("V10 双项证据持久化（AC4/AC7）", () => {
  it("真实V9库升级保留旧行NULL与旧策略，重复迁移及第二连接幂等", () => {
    const ctx = createTestDb();
    const db = new Database(":memory:");
    try {
      migrate(db, migrations.filter(m => m.version <= 9));
      const id = insertBulletinIfAbsent(db, makeNormalized(), { baseline: false }).id;
      db.prepare(`INSERT INTO evaluations (id, bulletin_id, need_id, need_name, need_note,
        need_version, config_version, rule_version, result, attempts, created_at, updated_at,
        decision_policy_json) VALUES ('old', ?, 'n1', '旧需求', '', 1, 1, 'old-rule', 'matched', 1, 'old', 'old', ?)`)
        .run(id, JSON.stringify({ minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 }));
      expect(migrate(db).applied).toEqual([10]);
      expect(migrate(db).applied).toEqual([]);
      const [row] = listEvaluationsByBulletin(db, id);
      expect(row.offerAssessment).toBeNull();
      expect(row.decisionPolicy).toEqual({ minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 });
      expect(row.result).toBe("matched");
      expect(row.updatedAt).toBe("old");
      const column = (db.prepare("PRAGMA table_info(evaluations)").all() as Array<{ name: string; notnull: number }>).find(c => c.name === "offer_assessment_json");
      expect(column?.notnull).toBe(0);
      // 文件库另开连接模拟另一进程启动：已应用V10不再执行ALTER。
      const second = new Database(ctx.db.name);
      try { expect(migrate(second).applied).toEqual([]); } finally { second.close(); }
    } finally { db.close(); ctx.close(); }
  });

  it("新策略与原始不完整概率往返，同规则覆盖一次、升规则保留旧证据", () => {
    const ctx = createTestDb();
    try {
      const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false }).id;
      const input = { bulletinId, needId: "n1", needName: "安踏", needNote: "", needVersion: 1, configVersion: 1,
        ruleVersion: "new-rule", result: "uncertain" as const, modelResult: "matched" as const,
        decisionPolicy: NEED_OFFER_CONFIRMATION_POLICY, decisionPolicyVersion: "need-offer-confirmation-v1",
        offerAssessment: offer, rawAnswer: "相关性原始值", probabilities: { matched: 0.76 }, jevRequestId: "req-one" };
      upsertEvaluation(ctx.db, input);
      let [row] = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(row.offerAssessment).toEqual(offer);
      expect(row.decisionPolicy).toEqual(NEED_OFFER_CONFIRMATION_POLICY);
      expect(row.rawAnswer).toBe("相关性原始值");
      expect(row.attempts).toBe(1);
      const createdAt = row.createdAt;
      const missing: OfferAssessment = { questionId: "offer_n1", result: "failed", probabilities: null, confidence: null, rawAnswer: null, error: "缺少该问题的答案" };
      upsertEvaluation(ctx.db, { ...input, result: "failed", offerAssessment: missing, jevRequestId: "req-two" });
      [row] = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(row.offerAssessment).toEqual(missing);
      expect(row.attempts).toBe(2);
      expect(row.createdAt).toBe(createdAt);
      expect(row.jevRequestId).toBe("req-two");
      upsertEvaluation(ctx.db, { ...input, ruleVersion: "next-rule" });
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)).toHaveLength(2);
    } finally { ctx.close(); }
  });

  it.each([
    "{bad-json", "null", "[]", '{"result":"matched"}',
    JSON.stringify({ ...offer, result: "maybe" }),
    JSON.stringify({ ...offer, probabilities: { matched: "high" } }),
    JSON.stringify({ ...offer, confidence: "0.8" }),
  ])("促销坏JSON／结构 %s 返回null，不默认通过", raw => {
    const ctx = createTestDb();
    try {
      const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false }).id;
      upsertEvaluation(ctx.db, { bulletinId, needId: "n1", needName: "安踏", needNote: "", needVersion: 1, configVersion: 1, ruleVersion: "r", result: "failed" });
      ctx.db.prepare("UPDATE evaluations SET offer_assessment_json = ?").run(raw);
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0].offerAssessment).toBeNull();
    } finally { ctx.close(); }
  });
  it.each([
    { kind: "unknown", minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
    { kind: "need_and_offer", relevance: { minMatchedProbability: null, probabilitySumTolerance: 0.01 } },
    { ...NEED_OFFER_CONFIRMATION_POLICY, offer: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 } },
    { ...NEED_OFFER_CONFIRMATION_POLICY, relevance: { minMatchedProbability: null, probabilitySumTolerance: "0.01" } },
  ])("新策略非法结构不回退旧／当前策略：%j", policy => {
    const ctx = createTestDb();
    try {
      const bulletinId = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false }).id;
      upsertEvaluation(ctx.db, { bulletinId, needId: "n1", needName: "安踏", needNote: "", needVersion: 1, configVersion: 1, ruleVersion: "r", result: "failed" });
      ctx.db.prepare("UPDATE evaluations SET decision_policy_json = ?").run(JSON.stringify(policy));
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0].decisionPolicy).toBeNull();
    } finally { ctx.close(); }
  });
});
