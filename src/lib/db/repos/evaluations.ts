import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ChoiceOutcome,
  DecisionReason,
  Evaluation,
  MatchConfirmationPolicy,
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
}

/**
 * 解码策略快照 JSON。只做基础结构校验（两个字段都是有限数字）；
 * 非法/缺失一律返回 null，绝不回退成当前默认策略。
 */
function decodeDecisionPolicy(
  raw: string | null,
): MatchConfirmationPolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const minMatchedProbability = record.minMatchedProbability;
    const probabilitySumTolerance = record.probabilitySumTolerance;
    if (
      typeof minMatchedProbability !== "number" ||
      !Number.isFinite(minMatchedProbability) ||
      typeof probabilitySumTolerance !== "number" ||
      !Number.isFinite(probabilitySumTolerance)
    ) {
      return null;
    }
    return { minMatchedProbability, probabilitySumTolerance };
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
    decisionPolicy: decodeDecisionPolicy(row.decision_policy_json),
    jevRequestId: row.jev_request_id,
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
  decisionPolicy?: MatchConfirmationPolicy | null;
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
       jev_request_id, attempts, created_at, updated_at
     ) VALUES (
       @id, @bulletinId, @needId, @needName, @needNote, @needVersion, @configVersion,
       @ruleVersion, @result, @probabilities, @confidence, @rawAnswer, @error,
       @modelResult, @decisionReason, @decisionPolicyVersion, @decisionPolicyJson,
       @jevRequestId, 1, @now, @now
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
