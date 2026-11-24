import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  JevCostStatus,
  Stage2PriceSource,
  Stage2Request,
  Stage2RequestPurpose,
  Stage2RequestStatus,
} from "@/lib/domain/types";
import { parseTokenCount } from "@/lib/jev/pricing";
import {
  estimateStage2Cost,
  resolveStage2Rates,
  type OpenRouterCatalogSnapshot,
} from "@/lib/stage2/pricing";

/**
 * 二级深度核验调用账本（`stage2_requests`）SQL 原语。
 *
 * - 一行代表一次**实际**二级上游模型请求（自动核验各轮、手动核验各轮、格式修正、重试与连接测试）；
 * - `result_recorded_at IS NULL` 为原子落账守卫，保证重复结算幂等；
 * - 租约过期回收为 `interrupted` 后 `result_recorded_at` 仍为 NULL，允许迟到真实结果补写一次；
 * - 费率快照按「美元 / 百万 Token」保存，估算金额按整数纳美元保存。
 */

interface Stage2RequestRow {
  id: string;
  purpose: string;
  bulletin_id: string | null;
  job_id: string | null;
  provider_origin: string | null;
  config_version: number | null;
  requested_model: string;
  response_model: string | null;
  matched_catalog_model_id: string | null;
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
  input_rate_usd_per_million: number | null;
  output_rate_usd_per_million: number | null;
  input_rate_source: string;
  output_rate_source: string;
  estimated_usd_nanos: number | null;
  cost_status: string;
  unknown_reason: string | null;
}

function toStage2Request(row: Stage2RequestRow): Stage2Request {
  return {
    id: row.id,
    purpose: row.purpose as Stage2RequestPurpose,
    bulletinId: row.bulletin_id,
    jobId: row.job_id,
    providerOrigin: row.provider_origin,
    configVersion: row.config_version,
    requestedModel: row.requested_model,
    responseModel: row.response_model,
    matchedCatalogModelId: row.matched_catalog_model_id,
    status: row.status as Stage2RequestStatus,
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
    inputRateUsdPerMillion: row.input_rate_usd_per_million,
    outputRateUsdPerMillion: row.output_rate_usd_per_million,
    inputRateSource: row.input_rate_source as Stage2PriceSource,
    outputRateSource: row.output_rate_source as Stage2PriceSource,
    estimatedUsdNanos: row.estimated_usd_nanos,
    costStatus: row.cost_status as JevCostStatus,
    unknownReason: row.unknown_reason,
  };
}

export function getStage2Request(
  db: Database.Database,
  id: string,
): Stage2Request | null {
  const row = db
    .prepare("SELECT * FROM stage2_requests WHERE id = ?")
    .get(id) as Stage2RequestRow | undefined;
  return row ? toStage2Request(row) : null;
}

export interface InsertInFlightStage2RequestInput {
  id?: string;
  purpose: Stage2RequestPurpose;
  bulletinId?: string | null;
  jobId?: string | null;
  providerOrigin: string | null;
  configVersion: number | null;
  requestedModel: string;
  startedAt: Date;
  leaseUntil: Date;
}

export function insertInFlightStage2Request(
  db: Database.Database,
  input: InsertInFlightStage2RequestInput,
): Stage2Request {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO stage2_requests (
       id, purpose, bulletin_id, job_id, provider_origin, config_version,
       requested_model, status, started_at, lease_until,
       input_rate_source, output_rate_source, cost_status
     ) VALUES (
       @id, @purpose, @bulletinId, @jobId, @providerOrigin, @configVersion,
       @requestedModel, 'in_flight', @startedAt, @leaseUntil,
       'unknown', 'unknown', 'unknown'
     )`,
  ).run({
    id,
    purpose: input.purpose,
    bulletinId: input.bulletinId ?? null,
    jobId: input.jobId ?? null,
    providerOrigin: input.providerOrigin,
    configVersion: input.configVersion,
    requestedModel: input.requestedModel,
    startedAt: input.startedAt.toISOString(),
    leaseUntil: input.leaseUntil.toISOString(),
  });
  const created = getStage2Request(db, id);
  if (!created) throw new Error(`创建二级调用账本失败：${id}`);
  return created;
}

/**
 * 回收过期的二级调用预留：标记为 `interrupted`、释放租约、费用未知。
 * `result_recorded_at` 仍为 NULL，迟到的真实响应可补写一次。
 */
export function reclaimExpiredStage2RequestReservations(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const nowIso = now.toISOString();
  const result = db
    .prepare(
      `UPDATE stage2_requests SET
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

export interface Stage2PricingSnapshotContext {
  manualInputUsdPerMillion: number | null;
  manualOutputUsdPerMillion: number | null;
  openRouterModelId: string | null;
  catalog: OpenRouterCatalogSnapshot | null;
}

export interface CompleteStage2RequestInput {
  id: string;
  status: "succeeded" | "failed";
  now: Date;
  responseModel?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  pricingContext: Stage2PricingSnapshotContext;
}

export interface CompleteStage2RequestResult {
  recorded: boolean;
  request: Stage2Request | null;
}

export function completeStage2Request(
  db: Database.Database,
  input: CompleteStage2RequestInput,
): CompleteStage2RequestResult {
  const run = db.transaction((): CompleteStage2RequestResult => {
    const existing = getStage2Request(db, input.id);
    if (!existing || existing.resultRecordedAt !== null) {
      return { recorded: false, request: existing };
    }

    const responseModel =
      typeof input.responseModel === "string" && input.responseModel.trim()
        ? input.responseModel.trim().slice(0, 200)
        : null;
    const inputTokens = parseTokenCount(input.inputTokens ?? null);
    const outputTokens = parseTokenCount(input.outputTokens ?? null);

    const rates = resolveStage2Rates({
      providerOrigin: existing.providerOrigin,
      requestedModel: existing.requestedModel,
      responseModel,
      manualInputUsdPerMillion: input.pricingContext.manualInputUsdPerMillion,
      manualOutputUsdPerMillion: input.pricingContext.manualOutputUsdPerMillion,
      openRouterModelId: input.pricingContext.openRouterModelId,
      catalog: input.pricingContext.catalog,
    });

    const estimate = estimateStage2Cost({
      inputTokens,
      outputTokens,
      rates,
    });

    const finishedAt = input.now.toISOString();
    const res = db
      .prepare(
        `UPDATE stage2_requests SET
           status = @status,
           finished_at = @finishedAt,
           result_recorded_at = @finishedAt,
           lease_until = NULL,
           response_model = @responseModel,
           matched_catalog_model_id = @matchedCatalogModelId,
           http_status = @httpStatus,
           error_code = @errorCode,
           error_message = @errorMessage,
           input_tokens = @inputTokens,
           output_tokens = @outputTokens,
           price_version = @priceVersion,
           input_rate_usd_per_million = @inputRateUsdPerMillion,
           output_rate_usd_per_million = @outputRateUsdPerMillion,
           input_rate_source = @inputRateSource,
           output_rate_source = @outputRateSource,
           estimated_usd_nanos = @estimatedUsdNanos,
           cost_status = @costStatus,
           unknown_reason = @unknownReason
         WHERE id = @id AND result_recorded_at IS NULL`,
      )
      .run({
        id: input.id,
        status: input.status,
        finishedAt,
        responseModel,
        matchedCatalogModelId: estimate.matchedCatalogModelId,
        httpStatus: input.httpStatus ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        inputTokens,
        outputTokens,
        priceVersion: estimate.priceVersion,
        inputRateUsdPerMillion: estimate.inputRateUsdPerMillion,
        outputRateUsdPerMillion: estimate.outputRateUsdPerMillion,
        inputRateSource: estimate.inputRateSource,
        outputRateSource: estimate.outputRateSource,
        estimatedUsdNanos: estimate.estimatedUsdNanos,
        costStatus: estimate.costStatus,
        unknownReason: estimate.unknownReason,
      });

    if (res.changes !== 1) {
      return { recorded: false, request: existing };
    }

    return {
      recorded: true,
      request: getStage2Request(db, input.id),
    };
  });

  return run.immediate();
}

export function getStage2StatsStartedAt(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT MIN(started_at) AS startedAt FROM stage2_requests")
    .get() as { startedAt: string | null } | undefined;
  return row?.startedAt ?? null;
}
