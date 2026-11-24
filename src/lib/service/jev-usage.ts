import type Database from "better-sqlite3";
import { formatUsdFromNanos } from "@/lib/jev/pricing";
import { getStage2StatsStartedAt } from "@/lib/db/repos/stage2-requests";
import type {
  JevCostStatus,
  JevRequestPurpose,
  JevRequestStatus,
  Stage2PriceSource,
  Stage2RequestPurpose,
  UsageStageScope,
} from "@/lib/domain/types";

/**
 * 一级 + 二级费用与用量统计的网页投影。
 *
 * - 只暴露清洗后的非敏感字段：不含 API 密钥、Authorization、URL 凭据/查询参数或上游原始正文；
 * - 金额同时返回整数纳美元与格式化美元字符串，保证极小正数不会被显示成 $0.00；
 * - API 省略 `stage` 时保持兼容 `stage1`；费用页默认请求 `all`；
 * - `all` / `stage2` 下忽略 `channelId` / `baseUrl`；
 * - 按模型汇总与模型筛选统一使用 `COALESCE(response_model, requested_model)`；
 * - 汇总、按模型分组、按 Key 分组与明细分页在同一同步只读事务内返回；
 * - 明细先筛选后 SQL 分页，按 `(started_at DESC, id DESC, stage DESC)` 稳定降序。
 */

export type UsageLedgerStage = "stage1" | "stage2";
export type UsageRequestPurpose = JevRequestPurpose | Stage2RequestPurpose;
export type UsageRateSource = Stage2PriceSource | "official";

export const JE_PURPOSE_LABELS: Record<JevRequestPurpose, string> = {
  evaluate: "后台判断",
  batch_gate: "批次初筛",
  test: "连接测试",
  dry_run: "需求试判",
};

export const STAGE2_PURPOSE_LABELS: Record<Stage2RequestPurpose, string> = {
  analyze: "二级核验",
  manual_analyze: "手动核验",
  test: "连接测试",
};

export const USAGE_STAGE_LABELS: Record<UsageLedgerStage, string> = {
  stage1: "一级",
  stage2: "二级",
};

export const JE_REQUEST_STATUS_LABELS: Record<JevRequestStatus, string> = {
  in_flight: "进行中",
  succeeded: "成功",
  failed: "失败",
  interrupted: "已中断（用量未知）",
};

export interface JevUsageRequestView {
  stage: UsageLedgerStage;
  stageLabel: string;
  id: string;
  channelId: string | null;
  baseUrl: string | null;
  /** 清洗后的服务来源（仅 scheme + host[:port]，不含凭据或查询参数）。 */
  providerOrigin: string | null;
  startedAt: string;
  finishedAt: string | null;
  purpose: UsageRequestPurpose;
  purposeLabel: string;
  status: JevRequestStatus;
  statusLabel: string;
  keyId: string | null;
  keyLabel: string | null;
  bulletinId: string | null;
  /** 所属处理 run / 子批（一级三模式追溯）；二级与旧账本为 null。 */
  evaluationRunId: string | null;
  batchPartId: string | null;
  requestedModel: string;
  responseModel: string | null;
  /** 统一有效模型名：`COALESCE(response_model, requested_model)`。 */
  effectiveModel: string;
  httpStatus: number | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costStatus: JevCostStatus;
  unknownReason: string | null;
  estimatedUsdNanos: number | null;
  /** 已知费用字符串；未知为 null，绝不显示为 $0.00。 */
  estimatedUsd: string | null;
  priceVersion: string | null;
  inputRateUsdPerMillion: number | null;
  outputRateUsdPerMillion: number | null;
  inputRateSource: UsageRateSource;
  outputRateSource: UsageRateSource;
  matchedCatalogModelId: string | null;
}

export interface JevUsageSummaryView {
  /** 统计开始时间（当前筛选范围内最早一次调用）；功能启用前没有记录。 */
  statsStartedAt: string | null;
  totalRequests: number;
  pendingCount: number;
  knownRequestCount: number;
  unknownCostCount: number;
  failedCount: number;
  inputTokensKnown: number;
  outputTokensKnown: number;
  knownCostNanos: number;
  knownCostUsd: string;
}

export interface JevUsageByKeyView {
  keyId: string | null;
  keyLabel: string | null;
  requestCount: number;
  /** 已按费率计价的调用数；`in_flight` 既不算已计价也不算「费用未知」。 */
  knownRequestCount: number;
  knownCostNanos: number;
  knownCostUsd: string;
  unknownCostCount: number;
  inputTokens: number;
  outputTokens: number;
  failedCount: number;
}

export interface UsageByModelView {
  stage: UsageLedgerStage;
  stageLabel: string;
  model: string;
  requestCount: number;
  knownRequestCount: number;
  knownCostNanos: number;
  knownCostUsd: string;
  unknownCostCount: number;
  inputTokens: number;
  outputTokens: number;
  failedCount: number;
}

export interface JevUsageView {
  stage: UsageStageScope;
  /** 二级逐次调用账本的最早记录时间；未产生二级调用时为 null。 */
  stage2StatsStartedAt: string | null;
  summary: JevUsageSummaryView;
  byKey: JevUsageByKeyView[];
  byModel: UsageByModelView[];
  availableModels: string[];
  recent: { items: JevUsageRequestView[]; total: number };
}

export interface JevUsageQuery {
  /** 核验级别范围；省略时默认 `stage1` 以兼容旧 API 契约。 */
  stage?: UsageStageScope;
  limit?: number;
  offset?: number;
  channelId?: string;
  baseUrl?: string;
  model?: string;
}

interface UnifiedLedgerRow {
  stage: UsageLedgerStage;
  id: string;
  channel_id: string | null;
  base_url: string | null;
  provider_origin: string | null;
  started_at: string;
  finished_at: string | null;
  purpose: string;
  status: string;
  key_id: string | null;
  key_label: string | null;
  bulletin_id: string | null;
  evaluation_run_id: string | null;
  batch_part_id: string | null;
  requested_model: string;
  response_model: string | null;
  effective_model: string;
  http_status: number | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_status: string;
  unknown_reason: string | null;
  estimated_usd_nanos: number | null;
  price_version: string | null;
  input_rate_usd_per_million: number | null;
  output_rate_usd_per_million: number | null;
  input_rate_source: string;
  output_rate_source: string;
  matched_catalog_model_id: string | null;
}

function purposeLabelFor(stage: UsageLedgerStage, purpose: string): string {
  if (stage === "stage2") {
    return (
      STAGE2_PURPOSE_LABELS[purpose as Stage2RequestPurpose] ?? purpose
    );
  }
  return JE_PURPOSE_LABELS[purpose as JevRequestPurpose] ?? purpose;
}

function toRequestView(row: UnifiedLedgerRow): JevUsageRequestView {
  const known = row.cost_status === "known";
  const status = row.status as JevRequestStatus;
  return {
    stage: row.stage,
    stageLabel: USAGE_STAGE_LABELS[row.stage],
    id: row.id,
    channelId: row.channel_id,
    baseUrl: row.base_url,
    providerOrigin: row.provider_origin,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    purpose: row.purpose as UsageRequestPurpose,
    purposeLabel: purposeLabelFor(row.stage, row.purpose),
    status,
    statusLabel: JE_REQUEST_STATUS_LABELS[status] ?? row.status,
    keyId: row.key_id,
    keyLabel: row.key_label,
    bulletinId: row.bulletin_id,
    evaluationRunId: row.evaluation_run_id,
    batchPartId: row.batch_part_id,
    requestedModel: row.requested_model,
    responseModel: row.response_model,
    effectiveModel: row.effective_model,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costStatus: row.cost_status as JevCostStatus,
    unknownReason: row.unknown_reason,
    estimatedUsdNanos: row.estimated_usd_nanos,
    estimatedUsd:
      known && row.estimated_usd_nanos !== null
        ? formatUsdFromNanos(row.estimated_usd_nanos)
        : null,
    priceVersion: row.price_version,
    inputRateUsdPerMillion: row.input_rate_usd_per_million,
    outputRateUsdPerMillion: row.output_rate_usd_per_million,
    inputRateSource: row.input_rate_source as UsageRateSource,
    outputRateSource: row.output_rate_source as UsageRateSource,
    matchedCatalogModelId: row.matched_catalog_model_id,
  };
}

function buildStage1Select(whereSql: string): string {
  return `
    SELECT
      'stage1' AS stage,
      id,
      channel_id,
      base_url,
      provider_origin,
      started_at,
      finished_at,
      purpose,
      status,
      key_id,
      key_label,
      bulletin_id,
      evaluation_run_id,
      batch_part_id,
      requested_model,
      response_model,
      COALESCE(response_model, requested_model) AS effective_model,
      http_status,
      error_message,
      input_tokens,
      output_tokens,
      cost_status,
      unknown_reason,
      estimated_usd_nanos,
      price_version,
      CASE WHEN input_rate_nanos_per_token IS NOT NULL THEN input_rate_nanos_per_token / 1000.0 ELSE NULL END AS input_rate_usd_per_million,
      CASE WHEN cost_status = 'known' THEN 0.0 ELSE NULL END AS output_rate_usd_per_million,
      CASE WHEN cost_status = 'known' THEN 'official' ELSE 'unknown' END AS input_rate_source,
      CASE WHEN cost_status = 'known' THEN 'official' ELSE 'unknown' END AS output_rate_source,
      NULL AS matched_catalog_model_id,
      result_recorded_at
    FROM jev_requests
    ${whereSql}
  `;
}

function buildStage2Select(whereSql: string): string {
  return `
    SELECT
      'stage2' AS stage,
      id,
      NULL AS channel_id,
      NULL AS base_url,
      provider_origin,
      started_at,
      finished_at,
      purpose,
      status,
      NULL AS key_id,
      NULL AS key_label,
      bulletin_id,
      NULL AS evaluation_run_id,
      NULL AS batch_part_id,
      requested_model,
      response_model,
      COALESCE(response_model, requested_model) AS effective_model,
      http_status,
      error_message,
      input_tokens,
      output_tokens,
      cost_status,
      unknown_reason,
      estimated_usd_nanos,
      price_version,
      input_rate_usd_per_million,
      output_rate_usd_per_million,
      input_rate_source,
      output_rate_source,
      matched_catalog_model_id,
      result_recorded_at
    FROM stage2_requests
    ${whereSql}
  `;
}

function buildUnifiedSource(
  stage: UsageStageScope,
  options: {
    channelId?: string;
    baseUrl?: string;
    model?: string;
  },
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const stage1Conds: string[] = [];
  const stage2Conds: string[] = [];

  // 仅 stage1 应用渠道筛选；all / stage2 忽略 channelId 与 baseUrl。
  if (stage === "stage1") {
    if (options.channelId) {
      stage1Conds.push("channel_id = @channelId");
      params.channelId = options.channelId;
    } else if (options.baseUrl) {
      stage1Conds.push("base_url = @baseUrl");
      params.baseUrl = options.baseUrl;
    }
  }

  if (options.model) {
    stage1Conds.push("COALESCE(response_model, requested_model) = @model");
    stage2Conds.push("COALESCE(response_model, requested_model) = @model");
    params.model = options.model;
  }

  const s1Where =
    stage1Conds.length > 0 ? `WHERE ${stage1Conds.join(" AND ")}` : "";
  const s2Where =
    stage2Conds.length > 0 ? `WHERE ${stage2Conds.join(" AND ")}` : "";

  if (stage === "stage1") {
    return { sql: buildStage1Select(s1Where), params };
  }
  if (stage === "stage2") {
    return { sql: buildStage2Select(s2Where), params };
  }
  return {
    sql: `${buildStage1Select(s1Where)} UNION ALL ${buildStage2Select(s2Where)}`,
    params,
  };
}

export function getJevUsageView(
  db: Database.Database,
  query: JevUsageQuery = {},
): JevUsageView {
  const stage: UsageStageScope = query.stage ?? "stage1";
  const model = query.model?.trim() || undefined;
  const channelId = stage === "stage1" ? query.channelId : undefined;
  const baseUrl = stage === "stage1" ? query.baseUrl : undefined;

  const rawLimit = Math.trunc(query.limit ?? 20);
  const rawOffset = Math.trunc(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 200)
    : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  // summary / byKey / byModel / availableModels / recent 在同一同步只读事务内读取，
  // 避免另一进程中途完成调用时返回互相矛盾的汇总与明细。
  const read = db.transaction((): JevUsageView => {
    const filtered = buildUnifiedSource(stage, { channelId, baseUrl, model });
    const unscopedByModel = buildUnifiedSource(stage, { channelId, baseUrl });

    const summaryRow = db
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
         FROM (${filtered.sql})`,
      )
      .get(filtered.params) as {
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

    const knownCostNanos = summaryRow?.knownCostNanos ?? 0;
    const summary: JevUsageSummaryView = {
      statsStartedAt: summaryRow?.statsStartedAt ?? null,
      totalRequests: summaryRow?.totalRequests ?? 0,
      pendingCount: summaryRow?.pendingCount ?? 0,
      knownRequestCount: summaryRow?.knownRequestCount ?? 0,
      unknownCostCount: summaryRow?.unknownCostCount ?? 0,
      failedCount: summaryRow?.failedCount ?? 0,
      inputTokensKnown: summaryRow?.inputTokensKnown ?? 0,
      outputTokensKnown: summaryRow?.outputTokensKnown ?? 0,
      knownCostNanos,
      knownCostUsd: formatUsdFromNanos(knownCostNanos),
    };

    let byKey: JevUsageByKeyView[] = [];
    if (stage === "stage1") {
      const keyRows = db
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
           FROM (${filtered.sql})
           GROUP BY key_id
           ORDER BY knownCostNanos DESC, requestCount DESC`,
        )
        .all(filtered.params) as Array<{
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
      byKey = keyRows.map((row) => {
        const nanos = row.knownCostNanos ?? 0;
        return {
          keyId: row.keyId,
          keyLabel: row.keyLabel,
          requestCount: row.requestCount,
          knownRequestCount: row.knownRequestCount ?? 0,
          knownCostNanos: nanos,
          knownCostUsd: formatUsdFromNanos(nanos),
          unknownCostCount: row.unknownCostCount ?? 0,
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          failedCount: row.failedCount ?? 0,
        };
      });
    }

    const byModelRows = db
      .prepare(
        `SELECT
           stage,
           effective_model AS model,
           COUNT(*) AS requestCount,
           SUM(CASE WHEN cost_status = 'known' THEN 1 ELSE 0 END) AS knownRequestCount,
           SUM(CASE WHEN cost_status = 'known' THEN estimated_usd_nanos ELSE 0 END) AS knownCostNanos,
           SUM(CASE WHEN cost_status = 'unknown' AND status <> 'in_flight' THEN 1 ELSE 0 END) AS unknownCostCount,
           SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS inputTokens,
           SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE 0 END) AS outputTokens,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount
         FROM (${filtered.sql})
         GROUP BY stage, effective_model
         ORDER BY knownCostNanos DESC, requestCount DESC, effective_model ASC, stage DESC`,
      )
      .all(filtered.params) as Array<{
      stage: UsageLedgerStage;
      model: string;
      requestCount: number;
      knownRequestCount: number | null;
      knownCostNanos: number | null;
      unknownCostCount: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      failedCount: number | null;
    }>;

    const byModel: UsageByModelView[] = byModelRows.map((row) => {
      const nanos = row.knownCostNanos ?? 0;
      return {
        stage: row.stage,
        stageLabel: USAGE_STAGE_LABELS[row.stage],
        model: row.model,
        requestCount: row.requestCount,
        knownRequestCount: row.knownRequestCount ?? 0,
        knownCostNanos: nanos,
        knownCostUsd: formatUsdFromNanos(nanos),
        unknownCostCount: row.unknownCostCount ?? 0,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        failedCount: row.failedCount ?? 0,
      };
    });

    const availableModels = (
      db
        .prepare(
          `SELECT DISTINCT effective_model AS model
           FROM (${unscopedByModel.sql})
           ORDER BY effective_model ASC`,
        )
        .all(unscopedByModel.params) as Array<{ model: string }>
    ).map((r) => r.model);

    const recentRows = db
      .prepare(
        `SELECT * FROM (${filtered.sql})
         ORDER BY started_at DESC, id DESC, stage DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...filtered.params, limit, offset }) as UnifiedLedgerRow[];

    const stage2StatsStartedAt = getStage2StatsStartedAt(db);

    return {
      stage,
      stage2StatsStartedAt,
      summary,
      byKey,
      byModel,
      availableModels,
      recent: {
        items: recentRows.map(toRequestView),
        total: summary.totalRequests,
      },
    };
  });

  return read();
}
