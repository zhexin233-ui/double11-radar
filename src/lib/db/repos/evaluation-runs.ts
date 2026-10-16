import type Database from "better-sqlite3";
import type {
  BatchPartState,
  BulletinProcessing,
  ChoiceOutcome,
  EvaluationBatchPart,
  EvaluationMode,
  EvaluationRun,
  NeedSnapshot,
  ProcessingStage,
  ScreeningSource,
} from "@/lib/domain/types";

/**
 * 三模式处理 run / 子批 / 成员处理记录仓库。
 *
 * - `evaluation_runs` 保存采集时的模式、全局规则与（batch_gate 的）需求快照；
 * - `evaluation_batch_parts` 的门控终态只能从 `pending` 进入一次；
 * - `bulletin_processing` 记录本地处理阶段与过滤来源，**不**创建伪模型 evaluation。
 *
 * 所有写入都是同步 SQL 原语，由调用方放在同一个事务内完成该事务的原子性。
 */

interface RunRow {
  id: string;
  source_ns: string;
  evaluation_mode: string;
  strategy_config_version: number;
  regex_rules_json: string | null;
  need_snapshots_json: string | null;
  created_at: string;
}

interface PartRow {
  id: string;
  run_id: string;
  ordinal: number;
  state: string;
  gate_result: string | null;
  gate_request_id: string | null;
  fallback_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ProcessingRow {
  bulletin_id: string;
  run_id: string;
  batch_part_id: string | null;
  position: number;
  stage: string;
  screening_source: string | null;
  screening_reason: string | null;
  gate_request_id: string | null;
  matched_rule_index: number | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toRun(row: RunRow): EvaluationRun {
  return {
    id: row.id,
    sourceNs: row.source_ns,
    evaluationMode: row.evaluation_mode as EvaluationMode,
    strategyConfigVersion: row.strategy_config_version,
    regexRules: parseJson<string[]>(row.regex_rules_json),
    needSnapshots: parseJson<NeedSnapshot[]>(row.need_snapshots_json),
    createdAt: row.created_at,
  };
}

function toPart(row: PartRow): EvaluationBatchPart {
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    state: row.state as BatchPartState,
    gateResult: (row.gate_result as ChoiceOutcome | null) ?? null,
    gateRequestId: row.gate_request_id,
    fallbackReason: row.fallback_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProcessing(row: ProcessingRow): BulletinProcessing {
  return {
    bulletinId: row.bulletin_id,
    runId: row.run_id,
    batchPartId: row.batch_part_id,
    position: row.position,
    stage: row.stage as ProcessingStage,
    screeningSource: (row.screening_source as ScreeningSource | null) ?? null,
    screeningReason: row.screening_reason,
    gateRequestId: row.gate_request_id,
    matchedRuleIndex: row.matched_rule_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateEvaluationRunInput {
  id: string;
  sourceNs: string;
  evaluationMode: EvaluationMode;
  strategyConfigVersion: number;
  regexRules: string[] | null;
  needSnapshots: NeedSnapshot[] | null;
  createdAt: string;
}

export function insertEvaluationRun(
  db: Database.Database,
  input: CreateEvaluationRunInput,
): EvaluationRun {
  db.prepare(
    `INSERT INTO evaluation_runs (
       id, source_ns, evaluation_mode, strategy_config_version,
       regex_rules_json, need_snapshots_json, created_at
     ) VALUES (
       @id, @sourceNs, @evaluationMode, @strategyConfigVersion,
       @regexRulesJson, @needSnapshotsJson, @createdAt
     )`,
  ).run({
    id: input.id,
    sourceNs: input.sourceNs,
    evaluationMode: input.evaluationMode,
    strategyConfigVersion: input.strategyConfigVersion,
    regexRulesJson: input.regexRules ? JSON.stringify(input.regexRules) : null,
    needSnapshotsJson: input.needSnapshots
      ? JSON.stringify(input.needSnapshots)
      : null,
    createdAt: input.createdAt,
  });
  const created = getEvaluationRun(db, input.id);
  if (!created) throw new Error(`创建处理 run 失败：${input.id}`);
  return created;
}

export function getEvaluationRun(
  db: Database.Database,
  id: string,
): EvaluationRun | null {
  const row = db
    .prepare("SELECT * FROM evaluation_runs WHERE id = ?")
    .get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export interface CreateBatchPartInput {
  id: string;
  runId: string;
  ordinal: number;
  createdAt: string;
}

export function insertBatchPart(
  db: Database.Database,
  input: CreateBatchPartInput,
): EvaluationBatchPart {
  db.prepare(
    `INSERT INTO evaluation_batch_parts (
       id, run_id, ordinal, state, created_at, updated_at
     ) VALUES (@id, @runId, @ordinal, 'pending', @createdAt, @createdAt)`,
  ).run(input);
  const created = getBatchPart(db, input.id);
  if (!created) throw new Error(`创建批次子批失败：${input.id}`);
  return created;
}

export function getBatchPart(
  db: Database.Database,
  id: string,
): EvaluationBatchPart | null {
  const row = db
    .prepare("SELECT * FROM evaluation_batch_parts WHERE id = ?")
    .get(id) as PartRow | undefined;
  return row ? toPart(row) : null;
}

export function listBatchPartsByRun(
  db: Database.Database,
  runId: string,
): EvaluationBatchPart[] {
  const rows = db
    .prepare(
      "SELECT * FROM evaluation_batch_parts WHERE run_id = ? ORDER BY ordinal ASC",
    )
    .all(runId) as PartRow[];
  return rows.map(toPart);
}

export interface CreateProcessingInput {
  bulletinId: string;
  runId: string;
  batchPartId: string | null;
  position: number;
  createdAt: string;
}

export function insertProcessing(
  db: Database.Database,
  input: CreateProcessingInput,
): void {
  db.prepare(
    `INSERT INTO bulletin_processing (
       bulletin_id, run_id, batch_part_id, position, stage, created_at, updated_at
     ) VALUES (@bulletinId, @runId, @batchPartId, @position, 'pending', @createdAt, @createdAt)`,
  ).run(input);
}

export function getProcessing(
  db: Database.Database,
  bulletinId: string,
): BulletinProcessing | null {
  const row = db
    .prepare("SELECT * FROM bulletin_processing WHERE bulletin_id = ?")
    .get(bulletinId) as ProcessingRow | undefined;
  return row ? toProcessing(row) : null;
}

export function listProcessingByPart(
  db: Database.Database,
  partId: string,
): BulletinProcessing[] {
  const rows = db
    .prepare(
      "SELECT * FROM bulletin_processing WHERE batch_part_id = ? ORDER BY position ASC",
    )
    .all(partId) as ProcessingRow[];
  return rows.map(toProcessing);
}

export interface ProcessingPatch {
  stage?: ProcessingStage;
  screeningSource?: ScreeningSource | null;
  screeningReason?: string | null;
  gateRequestId?: string | null;
  matchedRuleIndex?: number | null;
}

/** 更新单个成员的处理阶段（调用方负责在同一事务内做 owner 守卫）。 */
export function updateProcessing(
  db: Database.Database,
  bulletinId: string,
  patch: ProcessingPatch,
  now: string,
): boolean {
  const current = getProcessing(db, bulletinId);
  if (!current) return false;
  const result = db
    .prepare(
      `UPDATE bulletin_processing SET
         stage = @stage,
         screening_source = @screeningSource,
         screening_reason = @screeningReason,
         gate_request_id = @gateRequestId,
         matched_rule_index = @matchedRuleIndex,
         updated_at = @now
       WHERE bulletin_id = @bulletinId`,
    )
    .run({
      bulletinId,
      stage: patch.stage ?? current.stage,
      screeningSource:
        patch.screeningSource !== undefined
          ? patch.screeningSource
          : current.screeningSource,
      screeningReason:
        patch.screeningReason !== undefined
          ? patch.screeningReason
          : current.screeningReason,
      gateRequestId:
        patch.gateRequestId !== undefined
          ? patch.gateRequestId
          : current.gateRequestId,
      matchedRuleIndex:
        patch.matchedRuleIndex !== undefined
          ? patch.matchedRuleIndex
          : current.matchedRuleIndex,
      now,
    });
  return result.changes === 1;
}

export interface ExcludeBatchPartInput {
  partId: string;
  gateRequestId: string | null;
  gateResult: ChoiceOutcome;
  reason: string;
  now: string;
}

/**
 * 合法全否：一次 owner 校验事务内把 part 置 excluded、成员置 filtered。
 * 只允许从 `pending` 进入终态；重复执行返回 false（幂等完成）。
 */
export function excludeBatchPart(
  db: Database.Database,
  input: ExcludeBatchPartInput,
): boolean {
  const result = db
    .prepare(
      `UPDATE evaluation_batch_parts SET
         state = 'excluded', gate_result = @gateResult, gate_request_id = @gateRequestId,
         fallback_reason = NULL, updated_at = @now
       WHERE id = @partId AND state = 'pending'`,
    )
    .run(input);
  if (result.changes !== 1) return false;
  db.prepare(
    `UPDATE bulletin_processing SET
       stage = 'filtered', screening_source = 'batch_gate', screening_reason = @reason,
       gate_request_id = @gateRequestId, matched_rule_index = NULL, updated_at = @now
     WHERE batch_part_id = @partId AND stage IN ('pending', 'ready')`,
  ).run(input);
  return true;
}

export interface ExpandBatchPartInput {
  partId: string;
  gateRequestId: string | null;
  gateResult: ChoiceOutcome | null;
  fallbackReason: string | null;
  now: string;
}

/**
 * 放行或回退：把 part 置 expanded、成员置 ready。
 * 只允许从 `pending` 进入终态；重复执行返回 false（幂等完成）。
 */
export function expandBatchPart(
  db: Database.Database,
  input: ExpandBatchPartInput,
): boolean {
  const result = db
    .prepare(
      `UPDATE evaluation_batch_parts SET
         state = 'expanded', gate_result = @gateResult, gate_request_id = @gateRequestId,
         fallback_reason = @fallbackReason, updated_at = @now
       WHERE id = @partId AND state = 'pending'`,
    )
    .run(input);
  if (result.changes !== 1) return false;
  db.prepare(
    `UPDATE bulletin_processing SET
       stage = 'ready', screening_source = NULL,
       screening_reason = @fallbackReason, gate_request_id = @gateRequestId,
       matched_rule_index = NULL, updated_at = @now
     WHERE batch_part_id = @partId AND stage IN ('pending', 'ready')`,
  ).run(input);
  return true;
}
