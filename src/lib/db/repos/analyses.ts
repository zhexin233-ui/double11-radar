import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AnalysisStatus,
  AnalysisTriggerSource,
  AnalysisVerdict,
  BulletinAnalysis,
  StandardizedAnswer,
  ToolCallTraceEntry,
} from "@/lib/domain/types";

interface BulletinAnalysisRow {
  id: string;
  bulletin_id: string;
  trigger_source: string;
  status: string;
  verdict: string | null;
  model: string;
  base_url: string;
  active_tool_ids_json: string;
  steps_used: number;
  tool_calls_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number;
  answer_json: string | null;
  tool_trace_json: string;
  error: string | null;
  fallback_notified: number;
  created_at: string;
  updated_at: string;
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: BulletinAnalysisRow): BulletinAnalysis {
  return {
    id: row.id,
    bulletinId: row.bulletin_id,
    triggerSource: row.trigger_source as AnalysisTriggerSource,
    status: row.status as AnalysisStatus,
    verdict: (row.verdict as AnalysisVerdict | null) ?? null,
    model: row.model,
    baseUrl: row.base_url,
    activeToolIds: safeParseJson<string[]>(row.active_tool_ids_json, []),
    stepsUsed: row.steps_used,
    toolCallsCount: row.tool_calls_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    durationMs: row.duration_ms,
    answer: safeParseJson<StandardizedAnswer | null>(row.answer_json, null),
    toolTrace: safeParseJson<ToolCallTraceEntry[]>(row.tool_trace_json, []),
    error: row.error,
    fallbackNotified: row.fallback_notified === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertBulletinAnalysisInput {
  bulletinId: string;
  triggerSource: AnalysisTriggerSource;
  status: AnalysisStatus;
  verdict: AnalysisVerdict | null;
  model: string;
  baseUrl: string;
  activeToolIds: string[];
  stepsUsed: number;
  toolCallsCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  answer: StandardizedAnswer | null;
  toolTrace: ToolCallTraceEntry[];
  error: string | null;
  fallbackNotified?: boolean;
}

export function upsertBulletinAnalysis(
  db: Database.Database,
  input: UpsertBulletinAnalysisInput,
  now: Date = new Date(),
): BulletinAnalysis {
  const id = randomUUID();
  const nowIso = now.toISOString();

  db.prepare(
    `INSERT INTO bulletin_analyses (
      id, bulletin_id, trigger_source, status, verdict, model, base_url,
      active_tool_ids_json, steps_used, tool_calls_count,
      input_tokens, output_tokens, duration_ms,
      answer_json, tool_trace_json, error, fallback_notified,
      created_at, updated_at
    ) VALUES (
      @id, @bulletinId, @triggerSource, @status, @verdict, @model, @baseUrl,
      @activeToolIdsJson, @stepsUsed, @toolCallsCount,
      @inputTokens, @outputTokens, @durationMs,
      @answerJson, @toolTraceJson, @error, @fallbackNotified,
      @now, @now
    )
    ON CONFLICT(bulletin_id) DO UPDATE SET
      trigger_source = excluded.trigger_source,
      status = excluded.status,
      verdict = excluded.verdict,
      model = excluded.model,
      base_url = excluded.base_url,
      active_tool_ids_json = excluded.active_tool_ids_json,
      steps_used = excluded.steps_used,
      tool_calls_count = excluded.tool_calls_count,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      duration_ms = excluded.duration_ms,
      answer_json = excluded.answer_json,
      tool_trace_json = excluded.tool_trace_json,
      error = excluded.error,
      fallback_notified = excluded.fallback_notified,
      updated_at = excluded.updated_at`,
  ).run({
    id,
    bulletinId: input.bulletinId,
    triggerSource: input.triggerSource,
    status: input.status,
    verdict: input.verdict,
    model: input.model,
    baseUrl: input.baseUrl,
    activeToolIdsJson: JSON.stringify(input.activeToolIds ?? []),
    stepsUsed: input.stepsUsed,
    toolCallsCount: input.toolCallsCount,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    durationMs: input.durationMs,
    answerJson: input.answer ? JSON.stringify(input.answer) : null,
    toolTraceJson: JSON.stringify(input.toolTrace ?? []),
    error: input.error,
    fallbackNotified: input.fallbackNotified ? 1 : 0,
    now: nowIso,
  });

  return getBulletinAnalysis(db, input.bulletinId)!;
}

export function getBulletinAnalysis(
  db: Database.Database,
  bulletinId: string,
): BulletinAnalysis | null {
  const row = db
    .prepare("SELECT * FROM bulletin_analyses WHERE bulletin_id = ?")
    .get(bulletinId) as BulletinAnalysisRow | undefined;
  return row ? toRecord(row) : null;
}

export function markAnalysisFallbackNotified(
  db: Database.Database,
  bulletinId: string,
  now: Date = new Date(),
): boolean {
  const result = db
    .prepare(
      `UPDATE bulletin_analyses
       SET fallback_notified = 1,
           updated_at = ?
       WHERE bulletin_id = ?`,
    )
    .run(now.toISOString(), bulletinId);
  return result.changes > 0;
}
