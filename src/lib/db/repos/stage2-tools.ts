import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CachedMcpToolSchema,
  Stage2ToolHealthStatus,
  Stage2ToolKind,
  Stage2ToolRecord,
} from "@/lib/domain/types";

interface Stage2ToolRow {
  id: string;
  name: string;
  kind: string;
  builtin_key: string | null;
  enabled: number;
  sort_order: number;
  config_json: string;
  secret_namespace: string | null;
  cached_schema_json: string | null;
  health_status: string;
  consecutive_failures: number;
  failure_threshold: number;
  cooldown_minutes: number;
  cooldown_until: string | null;
  last_error: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 忽略损坏 JSON，退回空对象
  }
  return {};
}

function safeParseCachedSchema(raw: string | null): CachedMcpToolSchema[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as CachedMcpToolSchema[];
    }
  } catch {
    // 忽略损坏 JSON
  }
  return null;
}

function toRecord(row: Stage2ToolRow): Stage2ToolRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Stage2ToolKind,
    builtinKey: row.builtin_key,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    config: safeParseJsonObject(row.config_json),
    secretNamespace: row.secret_namespace,
    cachedSchema: safeParseCachedSchema(row.cached_schema_json),
    healthStatus: row.health_status as Stage2ToolHealthStatus,
    consecutiveFailures: row.consecutive_failures,
    failureThreshold: row.failure_threshold,
    cooldownMinutes: row.cooldown_minutes,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listStage2Tools(db: Database.Database): Stage2ToolRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM stage2_tools
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all() as Stage2ToolRow[];
  return rows.map(toRecord);
}

export function getStage2Tool(
  db: Database.Database,
  id: string,
): Stage2ToolRecord | null {
  const row = db
    .prepare("SELECT * FROM stage2_tools WHERE id = ?")
    .get(id) as Stage2ToolRow | undefined;
  return row ? toRecord(row) : null;
}

export function countStage2Tools(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM stage2_tools")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export interface CreateStage2ToolInput {
  id?: string;
  name: string;
  kind: Exclude<Stage2ToolKind, "builtin">;
  enabled?: boolean;
  sortOrder?: number;
  config: Record<string, unknown>;
  secretNamespace?: string | null;
  cachedSchema?: CachedMcpToolSchema[] | null;
  failureThreshold?: number;
  cooldownMinutes?: number;
}

export function createStage2Tool(
  db: Database.Database,
  input: CreateStage2ToolInput,
  now: Date = new Date(),
): Stage2ToolRecord {
  const id = input.id ?? randomUUID();
  const nowIso = now.toISOString();
  const secretNamespace =
    input.secretNamespace !== undefined
      ? input.secretNamespace
      : `stage2.tool.${id}`;

  db.prepare(
    `INSERT INTO stage2_tools (
      id, name, kind, builtin_key, enabled, sort_order, config_json,
      secret_namespace, cached_schema_json, health_status, consecutive_failures,
      failure_threshold, cooldown_minutes, created_at, updated_at
    ) VALUES (
      @id, @name, @kind, NULL, @enabled, @sortOrder, @configJson,
      @secretNamespace, @cachedSchemaJson, 'healthy', 0,
      @failureThreshold, @cooldownMinutes, @now, @now
    )`,
  ).run({
    id,
    name: input.name,
    kind: input.kind,
    enabled: input.enabled === false ? 0 : 1,
    sortOrder: input.sortOrder ?? 100,
    configJson: JSON.stringify(input.config ?? {}),
    secretNamespace,
    cachedSchemaJson: input.cachedSchema
      ? JSON.stringify(input.cachedSchema)
      : null,
    failureThreshold: input.failureThreshold ?? 3,
    cooldownMinutes: input.cooldownMinutes ?? 15,
    now: nowIso,
  });

  return getStage2Tool(db, id)!;
}

export interface UpdateStage2ToolPatch {
  name?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
  cachedSchema?: CachedMcpToolSchema[] | null;
  failureThreshold?: number;
  cooldownMinutes?: number;
}

export function updateStage2Tool(
  db: Database.Database,
  id: string,
  patch: UpdateStage2ToolPatch,
  now: Date = new Date(),
): Stage2ToolRecord | null {
  const current = getStage2Tool(db, id);
  if (!current) return null;

  const nowIso = now.toISOString();
  db.prepare(
    `UPDATE stage2_tools
     SET name = @name,
         enabled = @enabled,
         sort_order = @sortOrder,
         config_json = @configJson,
         cached_schema_json = @cachedSchemaJson,
         failure_threshold = @failureThreshold,
         cooldown_minutes = @cooldownMinutes,
         updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    name: patch.name ?? current.name,
    enabled:
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled ? 1 : 0,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    configJson: JSON.stringify(patch.config ?? current.config),
    cachedSchemaJson:
      patch.cachedSchema !== undefined
        ? patch.cachedSchema
          ? JSON.stringify(patch.cachedSchema)
          : null
        : current.cachedSchema
          ? JSON.stringify(current.cachedSchema)
          : null,
    failureThreshold: patch.failureThreshold ?? current.failureThreshold,
    cooldownMinutes: patch.cooldownMinutes ?? current.cooldownMinutes,
    now: nowIso,
  });

  return getStage2Tool(db, id);
}

export function deleteStage2Tool(db: Database.Database, id: string): boolean {
  const result = db
    .prepare("DELETE FROM stage2_tools WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

/**
 * 列出当前可执行（已启用且未处于熔断冷却期）的工具插件。
 * 若处于 `open_circuit` 且 `cooldown_until <= now`，允许半开试探放行。
 */
export function listRunnableStage2Tools(
  db: Database.Database,
  now: Date = new Date(),
): Stage2ToolRecord[] {
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM stage2_tools
       WHERE enabled = 1
         AND (
           health_status = 'healthy'
           OR (
             health_status = 'open_circuit'
             AND (cooldown_until IS NULL OR cooldown_until <= ?)
           )
         )
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(nowIso) as Stage2ToolRow[];
  return rows.map(toRecord);
}

export function recordStage2ToolSuccess(
  db: Database.Database,
  id: string,
  now: Date = new Date(),
): void {
  const nowIso = now.toISOString();
  db.prepare(
    `UPDATE stage2_tools
     SET health_status = 'healthy',
         consecutive_failures = 0,
         cooldown_until = NULL,
         last_error = NULL,
         last_success_at = @now,
         updated_at = @now
     WHERE id = @id`,
  ).run({ id, now: nowIso });
}

export function recordStage2ToolFailure(
  db: Database.Database,
  id: string,
  error: string,
  now: Date = new Date(),
): Stage2ToolRecord | null {
  const nowIso = now.toISOString();
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM stage2_tools WHERE id = ?")
      .get(id) as Stage2ToolRow | undefined;
    if (!row) return null;

    const nextFailures = row.consecutive_failures + 1;
    const shouldOpen =
      row.health_status === "open_circuit" ||
      nextFailures >= row.failure_threshold;
    const healthStatus: Stage2ToolHealthStatus = shouldOpen
      ? "open_circuit"
      : "healthy";
    const cooldownUntil = shouldOpen
      ? new Date(now.getTime() + row.cooldown_minutes * 60_000).toISOString()
      : null;

    db.prepare(
      `UPDATE stage2_tools
       SET health_status = @healthStatus,
           consecutive_failures = @consecutiveFailures,
           cooldown_until = @cooldownUntil,
           last_error = @lastError,
           last_failure_at = @now,
           updated_at = @now
       WHERE id = @id`,
    ).run({
      id,
      healthStatus,
      consecutiveFailures: nextFailures,
      cooldownUntil,
      lastError: error.slice(0, 1000),
      now: nowIso,
    });

    return getStage2Tool(db, id);
  });

  return tx.immediate();
}

export function resetStage2ToolCircuit(
  db: Database.Database,
  id: string,
  now: Date = new Date(),
): Stage2ToolRecord | null {
  const nowIso = now.toISOString();
  const result = db
    .prepare(
      `UPDATE stage2_tools
       SET health_status = 'healthy',
           consecutive_failures = 0,
           cooldown_until = NULL,
           last_error = NULL,
           updated_at = @now
       WHERE id = @id`,
    )
    .run({ id, now: nowIso });

  if (result.changes === 0) return null;
  return getStage2Tool(db, id);
}
