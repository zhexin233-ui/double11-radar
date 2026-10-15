import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  JevCostStatus,
  JevRequest,
  JevRequestPurpose,
  JevRequestStatus,
} from "@/lib/domain/types";
import { estimateCost } from "@/lib/jev/pricing";
import {
  JE_RATE_LIMIT_BASE_BACKOFF_MS,
  JE_RATE_LIMIT_MAX_BACKOFF_MS,
} from "@/lib/jev/client";
import {
  recordJevKeyFailure,
  recordJevKeySuccess,
  setJevKeyCooldown,
} from "@/lib/db/repos/jev-keys";
import { setJevCooldown } from "@/lib/db/repos/jev-cooldown";

/**
 * Jev 调用账本的 SQL 原语（不含 Key 选择/容量编排，那部分在 service 层）。
 *
 * 一条 `jev_requests` 行代表一次**实际**上游调用（含连接测试、试判与每次重试）。
 * `result_recorded_at` 是「真实结果已落账」的唯一标记：
 * - 预留时为空；租约过期被回收为 `interrupted` 后仍为空（容量已释放，但费用未知）；
 * - 迟到的真实响应可通过 `completeJevRequest` 原子补写一次；
 * - 已经有结果的行使不会二次累计用量或健康计数。
 */

interface JevRequestRow {
  id: string;
  upstream_request_id: string | null;
  key_id: string | null;
  key_label: string | null;
  key_generation: number | null;
  purpose: string;
  bulletin_id: string | null;
  job_id: string | null;
  requested_model: string;
  response_model: string | null;
  provider_origin: string | null;
  config_version: number | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  lease_until: string | null;
  result_recorded_at: string | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  price_version: string | null;
  input_rate_nanos_per_token: number | null;
  estimated_usd_nanos: number | null;
  cost_status: string;
  unknown_reason: string | null;
}

function toJevRequest(row: JevRequestRow): JevRequest {
  return {
    id: row.id,
    upstreamRequestId: row.upstream_request_id,
    keyId: row.key_id,
    keyLabel: row.key_label,
    keyGeneration: row.key_generation,
    purpose: row.purpose as JevRequestPurpose,
    bulletinId: row.bulletin_id,
    jobId: row.job_id,
    requestedModel: row.requested_model,
    responseModel: row.response_model,
    providerOrigin: row.provider_origin,
    configVersion: row.config_version,
    status: row.status as JevRequestStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseUntil: row.lease_until,
    resultRecordedAt: row.result_recorded_at,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    priceVersion: row.price_version,
    inputRateNanosPerToken: row.input_rate_nanos_per_token,
    estimatedUsdNanos: row.estimated_usd_nanos,
    costStatus: row.cost_status as JevCostStatus,
    unknownReason: row.unknown_reason,
  };
}

export function getJevRequest(
  db: Database.Database,
  id: string,
): JevRequest | null {
  const row = db.prepare("SELECT * FROM jev_requests WHERE id = ?").get(id) as
    | JevRequestRow
    | undefined;
  return row ? toJevRequest(row) : null;
}

export interface InsertInFlightInput {
  id?: string;
  keyId: string;
  keyLabel: string;
  keyGeneration: number;
  purpose: JevRequestPurpose;
  bulletinId?: string | null;
  jobId?: string | null;
  requestedModel: string;
  providerOrigin: string | null;
  configVersion: number | null;
  startedAt: Date;
  leaseUntil: Date;
}

/** 预留一条 in_flight 行；调用方必须在事务内使用。 */
export function insertInFlightRequest(
  db: Database.Database,
  input: InsertInFlightInput,
): JevRequest {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO jev_requests (
       id, key_id, key_label, key_generation, purpose, bulletin_id, job_id,
       requested_model, provider_origin, config_version, status, started_at,
       lease_until, cost_status
     ) VALUES (
       @id, @keyId, @keyLabel, @keyGeneration, @purpose, @bulletinId, @jobId,
       @requestedModel, @providerOrigin, @configVersion, 'in_flight', @startedAt,
       @leaseUntil, 'unknown'
     )`,
  ).run({
    id,
    keyId: input.keyId,
    keyLabel: input.keyLabel,
    keyGeneration: input.keyGeneration,
    purpose: input.purpose,
    bulletinId: input.bulletinId ?? null,
    jobId: input.jobId ?? null,
    requestedModel: input.requestedModel,
    providerOrigin: input.providerOrigin,
    configVersion: input.configVersion,
    startedAt: input.startedAt.toISOString(),
    leaseUntil: input.leaseUntil.toISOString(),
  });
  const created = getJevRequest(db, id);
  if (!created) throw new Error(`创建 Jev 调用账本失败：${id}`);
  return created;
}

/** 所有入口合计的有效在途数（租约未过期、尚无真实结果）。 */
export function countActiveInFlight(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM jev_requests
       WHERE status = 'in_flight' AND result_recorded_at IS NULL
         AND (lease_until IS NULL OR lease_until > @now)`,
    )
    .get({ now: now.toISOString() }) as { count: number };
  return row.count;
}

/** 每个 Key 当前有效在途数（用于「最低负载优先」选择）。 */
export function countInFlightByKey(
  db: Database.Database,
  now: Date = new Date(),
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT key_id AS keyId, COUNT(*) AS count FROM jev_requests
       WHERE status = 'in_flight' AND result_recorded_at IS NULL
         AND (lease_until IS NULL OR lease_until > @now)
         AND key_id IS NOT NULL
       GROUP BY key_id`,
    )
    .all({ now: now.toISOString() }) as Array<{ keyId: string; count: number }>;
  return new Map(rows.map((row) => [row.keyId, row.count]));
}

/**
 * 回收过期的 in_flight 预留：转为 `interrupted`、释放容量、费用未知。
 * 不写 Key 健康计数——没有响应不能判定认证失败，也不能伪造零账单。
 * 已被回收的行仍可被迟到真实结果补写一次（result_recorded_at 仍为空）。
 */
export function reclaimExpiredRequestReservations(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const nowIso = now.toISOString();
  const result = db
    .prepare(
      `UPDATE jev_requests SET
         status = 'interrupted',
         finished_at = @now,
         lease_until = NULL,
         cost_status = 'unknown',
         unknown_reason = '请求租约到期仍未收到结果（进程可能中断）'
       WHERE status = 'in_flight' AND result_recorded_at IS NULL
         AND lease_until IS NOT NULL AND lease_until <= @now`,
    )
    .run({ now: nowIso });
  return result.changes;
}

export interface CompleteJevRequestInput {
  id: string;
  status: "succeeded" | "failed";
  now: Date;
  upstreamRequestId?: string | null;
  responseModel?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** 上游 Retry-After（毫秒）；有值时写入共享退避与 Key 冷却。 */
  retryAfterMs?: number | null;
  /** 是否属于限流/过载（429/529）：无 Retry-After 时按有限指数退避。 */
  rateLimited?: boolean;
}

export interface CompleteJevRequestResult {
  /** 本次调用是否真正落账（已有真实结果时为 false，不重复累计）。 */
  recorded: boolean;
  request: JevRequest | null;
  keyDisabled: boolean;
}

/**
 * 原子落账一次真实结果。
 *
 * - 只有当 `result_recorded_at IS NULL` 时才更新，保证用量/费用/健康计数只计一次；
 * - `interrupted` 行（租约已回收但无真实结果）允许被迟到响应补写为终态；
 * - 健康计数与账本在同一调用栈内写入，已禁用 Key 的状态不会被迟到成功改写；
 * - `retryAfterMs` 同时更新共享 provider 退避与对应 Key 冷却。
 */
export function completeJevRequest(
  db: Database.Database,
  input: CompleteJevRequestInput,
): CompleteJevRequestResult {
  const run = db.transaction((): CompleteJevRequestResult => {
    const existing = getJevRequest(db, input.id);
    if (!existing || existing.resultRecordedAt !== null) {
      return { recorded: false, request: existing, keyDisabled: false };
    }

    const responseModel = input.responseModel ?? null;
    const inputTokens = input.inputTokens ?? null;
    const outputTokens = input.outputTokens ?? null;
    const estimate = estimateCost({
      inputTokens,
      outputTokens,
      responseModel,
      providerOrigin: existing.providerOrigin,
    });
    const finishedAt = input.now.toISOString();

    const result = db
      .prepare(
        `UPDATE jev_requests SET
           status = @status,
           finished_at = @finishedAt,
           result_recorded_at = @finishedAt,
           lease_until = NULL,
           upstream_request_id = @upstreamRequestId,
           response_model = @responseModel,
           http_status = @httpStatus,
           error_code = @errorCode,
           error_message = @errorMessage,
           input_tokens = @inputTokens,
           output_tokens = @outputTokens,
           price_version = @priceVersion,
           input_rate_nanos_per_token = @inputRate,
           estimated_usd_nanos = @estimated,
           cost_status = @costStatus,
           unknown_reason = @unknownReason
         WHERE id = @id AND result_recorded_at IS NULL`,
      )
      .run({
        id: input.id,
        status: input.status,
        finishedAt,
        upstreamRequestId: input.upstreamRequestId ?? null,
        responseModel,
        httpStatus: input.httpStatus ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        inputTokens,
        outputTokens,
        priceVersion: estimate.priceVersion,
        inputRate: estimate.inputRateNanosPerToken,
        estimated: estimate.estimatedUsdNanos,
        costStatus: estimate.costStatus,
        unknownReason: estimate.unknownReason,
      });

    if (result.changes !== 1) {
      return { recorded: false, request: existing, keyDisabled: false };
    }

    let keyDisabled = false;
    if (existing.keyId && existing.keyGeneration !== null) {
      const health = { keyId: existing.keyId, generation: existing.keyGeneration, now: input.now };
      let failures: number | null = null;
      if (input.status === "succeeded") {
        recordJevKeySuccess(db, health);
      } else {
        const failure = recordJevKeyFailure(db, {
          ...health,
          error: input.errorMessage ?? "Jev 请求失败",
        });
        keyDisabled = failure.disabled;
        if (failure.applied) failures = failure.consecutiveFailures;
      }
      if (input.status === "failed" && input.rateLimited) {
        const fromHeader = input.retryAfterMs ?? null;
        const backoffMs =
          fromHeader !== null && fromHeader > 0
            ? fromHeader
            : Math.min(
                JE_RATE_LIMIT_BASE_BACKOFF_MS *
                  2 ** Math.max(0, (failures ?? 1) - 1),
                JE_RATE_LIMIT_MAX_BACKOFF_MS,
              );
        const until = new Date(input.now.getTime() + backoffMs);
        setJevCooldown(
          db,
          until,
          fromHeader
            ? "上游要求退避（Retry-After）"
            : "上游限流/过载，按有限指数退避",
          input.now,
        );
        setJevKeyCooldown(db, existing.keyId, until.toISOString(), input.now);
      }
    }

    return {
      recorded: true,
      request: getJevRequest(db, input.id),
      keyDisabled,
    };
  });
  return run.immediate();
}

// ── 汇总查询（供 /api/settings/jev/usage） ─────────────────────────────────

export interface JevUsageSummary {
  statsStartedAt: string | null;
  totalRequests: number;
  pendingCount: number;
  knownRequestCount: number;
  knownCostNanos: number;
  unknownCostCount: number;
  failedCount: number;
  inputTokensKnown: number;
  outputTokensKnown: number;
}

export function getJevUsageSummary(db: Database.Database): JevUsageSummary {
  const row = db
    .prepare(
      `SELECT
         MIN(started_at) AS statsStartedAt,
         COUNT(*) AS totalRequests,
         SUM(CASE WHEN status = 'in_flight' AND result_recorded_at IS NULL THEN 1 ELSE 0 END) AS pendingCount,
         SUM(CASE WHEN cost_status = 'known' THEN 1 ELSE 0 END) AS knownRequestCount,
         SUM(CASE WHEN cost_status = 'known' THEN estimated_usd_nanos ELSE 0 END) AS knownCostNanos,
         SUM(CASE WHEN cost_status = 'unknown' AND status <> 'in_flight' THEN 1 ELSE 0 END) AS unknownCostCount,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
         SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS inputTokensKnown,
         SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE 0 END) AS outputTokensKnown
       FROM jev_requests`,
    )
    .get() as {
    statsStartedAt: string | null;
    totalRequests: number | null;
    pendingCount: number | null;
    knownRequestCount: number | null;
    knownCostNanos: number | null;
    unknownCostCount: number | null;
    failedCount: number | null;
    inputTokensKnown: number | null;
    outputTokensKnown: number | null;
  };
  return {
    statsStartedAt: row?.statsStartedAt ?? null,
    totalRequests: row?.totalRequests ?? 0,
    pendingCount: row?.pendingCount ?? 0,
    knownRequestCount: row?.knownRequestCount ?? 0,
    knownCostNanos: row?.knownCostNanos ?? 0,
    unknownCostCount: row?.unknownCostCount ?? 0,
    failedCount: row?.failedCount ?? 0,
    inputTokensKnown: row?.inputTokensKnown ?? 0,
    outputTokensKnown: row?.outputTokensKnown ?? 0,
  };
}

export interface JevUsageByKey {
  keyId: string | null;
  keyLabel: string | null;
  requestCount: number;
  /** 已按费率计价的调用数（`cost_status = 'known'`）；`in_flight` 不计入。 */
  knownRequestCount: number;
  knownCostNanos: number;
  unknownCostCount: number;
  inputTokens: number;
  outputTokens: number;
  failedCount: number;
}

export function getJevUsageByKey(db: Database.Database): JevUsageByKey[] {
  const rows = db
    .prepare(
      `SELECT
         key_id AS keyId,
         MAX(key_label) AS keyLabel,
         COUNT(*) AS requestCount,
         SUM(CASE WHEN cost_status = 'known' THEN 1 ELSE 0 END) AS knownRequestCount,
         SUM(CASE WHEN cost_status = 'known' THEN estimated_usd_nanos ELSE 0 END) AS knownCostNanos,
         SUM(CASE WHEN cost_status = 'unknown' AND status <> 'in_flight' THEN 1 ELSE 0 END) AS unknownCostCount,
         SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS inputTokens,
         SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE 0 END) AS outputTokens,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount
       FROM jev_requests
       GROUP BY key_id
       ORDER BY knownCostNanos DESC, requestCount DESC`,
    )
    .all() as Array<{
    keyId: string | null;
    keyLabel: string | null;
    requestCount: number;
    knownRequestCount: number | null;
    knownCostNanos: number | null;
    unknownCostCount: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    failedCount: number | null;
  }>;
  return rows.map((row) => ({
    keyId: row.keyId,
    keyLabel: row.keyLabel,
    requestCount: row.requestCount,
    knownRequestCount: row.knownRequestCount ?? 0,
    knownCostNanos: row.knownCostNanos ?? 0,
    unknownCostCount: row.unknownCostCount ?? 0,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    failedCount: row.failedCount ?? 0,
  }));
}

export interface JevRequestQuery {
  limit?: number;
  offset?: number;
}

export function listRecentJevRequests(
  db: Database.Database,
  query: JevRequestQuery = {},
): { items: JevRequest[]; total: number } {
  // 非法/小数 limit/offset 一律按整数回退：SQLite 的 LIMIT/OFFSET 只接受整数。
  const rawLimit = Math.trunc(query.limit ?? 20);
  const rawOffset = Math.trunc(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 200)
    : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  const total = db.prepare("SELECT COUNT(*) AS count FROM jev_requests").get() as {
    count: number;
  };
  const rows = db
    .prepare(
      `SELECT * FROM jev_requests
       ORDER BY started_at DESC, id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ limit, offset }) as JevRequestRow[];
  return { items: rows.map(toJevRequest), total: total.count };
}
