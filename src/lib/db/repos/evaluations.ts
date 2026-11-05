import { z } from "zod";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ChoiceOutcome,
  DecisionReason,
  Evaluation,
  DecisionPolicy,
  OfferAssessment,
} from "@/lib/domain/types";

/**
 * 判断记录仓库。
 *
 * 每条记录保存需求快照（名称/备注/版本），因此删除或改名需求不会破坏历史记录。
 * 唯一键 `(bulletin_id, need_id, rule_version)` 使重复处理同一规则版本时幂等。
 *
 * 本仓库是 `decision_policy_json` 的唯一解码 owner：旧行 NULL、异常 JSON 或缺少
 * 基础结构都返回 null（不默认为当前策略，也不让详情崩溃）。
 */

interface EvaluationRow {
  id: string;
  bulletin_id: string;
  need_id: string;
  need_name: string;
  need_note: string;
  need_version: number;
  config_version: number;
  rule_version: string;
  result: string;
  probabilities: string | null;
  confidence: number | null;
  raw_answer: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  model_result: string | null;
  decision_reason: string | null;
  decision_policy_version: string | null;
  decision_policy_json: string | null;
  jev_request_id: string | null;
  offer_assessment_json: string | null;
}

const LegacyPolicySchema = z.object({
  minMatchedProbability: z.number(),
  probabilitySumTolerance: z.number(),
}).strict();
const DimensionPolicySchema = z.object({
  minMatchedProbability: z.null(),
  probabilitySumTolerance: z.number().nonnegative(),
});
const DecisionPolicySchema = z.union([
  LegacyPolicySchema,
  z.object({
    kind: z.literal("need_and_offer"),
    relevance: DimensionPolicySchema,
    offer: DimensionPolicySchema,
  }),
]);
const OfferAssessmentSchema = z.object({
  questionId: z.string().min(1),
  result: z.enum(["matched", "not_matched", "uncertain", "failed"]),
  // 留存原始不完整／越界概率，业务合法性由纯决策校验，解码不归一化。
  probabilities: z.record(z.string(), z.number()).nullable(),
  confidence: z.number().nullable(),
  rawAnswer: z.string().nullable(),
  error: z.string().nullable(),
});

/** 仓库独占持久化 JSON 解码；坏数据为 null，绝不补当前策略或促销通过。 */
function decodeJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toEvaluation(row: EvaluationRow): Evaluation {
  return {
    id: row.id,
    bulletinId: row.bulletin_id,
    needId: row.need_id,
    needName: row.need_name,
    needNote: row.need_note,
    needVersion: row.need_version,
    configVersion: row.config_version,
    ruleVersion: row.rule_version,
    result: row.result as Evaluation["result"],
    probabilities: row.probabilities,
    confidence: row.confidence,
    rawAnswer: row.raw_answer,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelResult: row.model_result as ChoiceOutcome | null,
    decisionReason: row.decision_reason as DecisionReason | null,
    decisionPolicyVersion: row.decision_policy_version,
    decisionPolicy: decodeJson(row.decision_policy_json, DecisionPolicySchema),
    jevRequestId: row.jev_request_id,
    offerAssessment: decodeJson(row.offer_assessment_json, OfferAssessmentSchema),
  };
}

export interface UpsertEvaluationInput {
  bulletinId: string;
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  configVersion: number;
  ruleVersion: string;
  result: ChoiceOutcome | "failed";
  probabilities?: Record<string, number> | null;
  confidence?: number | null;
  rawAnswer?: string | null;
  error?: string | null;
  /** 匹配确认追溯字段；旧调用/回退路径省略时为 null。 */
  modelResult?: ChoiceOutcome | null;
  decisionReason?: DecisionReason | null;
  decisionPolicyVersion?: string | null;
  decisionPolicy?: DecisionPolicy | null;
  offerAssessment?: OfferAssessment | null;
  jevRequestId?: string | null;
}

export function upsertEvaluation(
  db: Database.Database,
  input: UpsertEvaluationInput,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO evaluations (
       id, bulletin_id, need_id, need_name, need_note, need_version, config_version,
       rule_version, result, probabilities, confidence, raw_answer, error,
       model_result, decision_reason, decision_policy_version, decision_policy_json,
       jev_request_id, offer_assessment_json, attempts, created_at, updated_at
     ) VALUES (
       @id, @bulletinId, @needId, @needName, @needNote, @needVersion, @configVersion,
       @ruleVersion, @result, @probabilities, @confidence, @rawAnswer, @error,
       @modelResult, @decisionReason, @decisionPolicyVersion, @decisionPolicyJson,
       @jevRequestId, @offerAssessmentJson, 1, @now, @now
     )
     ON CONFLICT(bulletin_id, need_id, rule_version) DO UPDATE SET
       need_name = excluded.need_name,
       need_note = excluded.need_note,
       need_version = excluded.need_version,
       config_version = excluded.config_version,
       result = excluded.result,
       probabilities = excluded.probabilities,
       confidence = excluded.confidence,
       raw_answer = excluded.raw_answer,
       error = excluded.error,
       model_result = excluded.model_result,
       decision_reason = excluded.decision_reason,
       decision_policy_version = excluded.decision_policy_version,
       decision_policy_json = excluded.decision_policy_json,
       jev_request_id = excluded.jev_request_id,
       offer_assessment_json = excluded.offer_assessment_json,
       attempts = evaluations.attempts + 1,
       updated_at = excluded.updated_at`,
  ).run({
    id: randomUUID(),
    bulletinId: input.bulletinId,
    needId: input.needId,
    needName: input.needName,
    needNote: input.needNote,
    needVersion: input.needVersion,
    configVersion: input.configVersion,
    ruleVersion: input.ruleVersion,
    result: input.result,
    probabilities: input.probabilities ? JSON.stringify(input.probabilities) : null,
    confidence: input.confidence ?? null,
    rawAnswer: input.rawAnswer ?? null,
    error: input.error ?? null,
    modelResult: input.modelResult ?? null,
    decisionReason: input.decisionReason ?? null,
    decisionPolicyVersion: input.decisionPolicyVersion ?? null,
    decisionPolicyJson: input.decisionPolicy
      ? JSON.stringify(input.decisionPolicy)
      : null,
    jevRequestId: input.jevRequestId ?? null,
    offerAssessmentJson: input.offerAssessment ? JSON.stringify(input.offerAssessment) : null,
    now,
  });
}

export function listEvaluationsByBulletin(
  db: Database.Database,
  bulletinId: string,
): Evaluation[] {
  const rows = db
    .prepare(
      "SELECT * FROM evaluations WHERE bulletin_id = ? ORDER BY created_at ASC",
    )
    .all(bulletinId) as EvaluationRow[];
  return rows.map(toEvaluation);
}

export function listMatchedByBulletin(
  db: Database.Database,
  bulletinId: string,
): Evaluation[] {
  const rows = db
    .prepare(
      `SELECT * FROM evaluations
       WHERE bulletin_id = ? AND result = 'matched'
       ORDER BY created_at ASC`,
    )
    .all(bulletinId) as EvaluationRow[];
  return rows.map(toEvaluation);
}

export function countEvaluations(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM evaluations").get() as {
    count: number;
  };
  return row.count;
}
