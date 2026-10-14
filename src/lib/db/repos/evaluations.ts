import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChoiceOutcome, Evaluation } from "@/lib/domain/types";

/**
 * 判断记录仓库。
 *
 * 每条记录保存需求快照（名称/备注/版本），因此删除或改名需求不会破坏历史记录。
 * 唯一键 `(bulletin_id, need_id, rule_version)` 使重复处理同一规则版本时幂等。
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
       attempts, created_at, updated_at
     ) VALUES (
       @id, @bulletinId, @needId, @needName, @needNote, @needVersion, @configVersion,
       @ruleVersion, @result, @probabilities, @confidence, @rawAnswer, @error,
       1, @now, @now
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
