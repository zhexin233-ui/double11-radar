import type Database from "better-sqlite3";
import { formatUsdFromNanos } from "@/lib/jev/pricing";
import {
  getJevUsageByKey,
  getJevUsageSummary,
  listRecentJevRequests,
} from "@/lib/db/repos/jev-requests";
import type {
  JevCostStatus,
  JevRequest,
  JevRequestPurpose,
  JevRequestStatus,
} from "@/lib/domain/types";

/**
 * 费用统计的网页投影。
 *
 * 只暴露清洗后的非敏感字段：不含 API 密钥、Authorization 或上游原始正文。
 * 金额同时返回整数纳美元与格式化美元字符串，保证极小正数不会被显示成 $0.00
 * （格式化实现只有 `lib/jev/pricing.ts` 一处）。
 */

export const JE_PURPOSE_LABELS: Record<JevRequestPurpose, string> = {
  evaluate: "后台判断",
  test: "连接测试",
  dry_run: "需求试判",
};

export const JE_REQUEST_STATUS_LABELS: Record<JevRequestStatus, string> = {
  in_flight: "进行中",
  succeeded: "成功",
  failed: "失败",
  interrupted: "已中断（用量未知）",
};

export interface JevUsageRequestView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  purpose: JevRequestPurpose;
  purposeLabel: string;
  status: JevRequestStatus;
  statusLabel: string;
  keyId: string | null;
  keyLabel: string | null;
  bulletinId: string | null;
  requestedModel: string;
  responseModel: string | null;
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
}

export interface JevUsageSummaryView {
  /** 统计开始时间（账本中最早一次调用）；功能启用前没有记录。 */
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

export interface JevUsageView {
  summary: JevUsageSummaryView;
  byKey: JevUsageByKeyView[];
  recent: { items: JevUsageRequestView[]; total: number };
}

function toRequestView(request: JevRequest): JevUsageRequestView {
  const known = request.costStatus === "known";
  return {
    id: request.id,
    startedAt: request.startedAt,
    finishedAt: request.finishedAt,
    purpose: request.purpose,
    purposeLabel: JE_PURPOSE_LABELS[request.purpose],
    status: request.status,
    statusLabel: JE_REQUEST_STATUS_LABELS[request.status],
    keyId: request.keyId,
    keyLabel: request.keyLabel,
    bulletinId: request.bulletinId,
    requestedModel: request.requestedModel,
    responseModel: request.responseModel,
    httpStatus: request.httpStatus,
    errorMessage: request.errorMessage,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    costStatus: request.costStatus,
    unknownReason: request.unknownReason,
    estimatedUsdNanos: request.estimatedUsdNanos,
    estimatedUsd:
      known && request.estimatedUsdNanos !== null
        ? formatUsdFromNanos(request.estimatedUsdNanos)
        : null,
    priceVersion: request.priceVersion,
  };
}

export interface JevUsageQuery {
  limit?: number;
  offset?: number;
}

export function getJevUsageView(
  db: Database.Database,
  query: JevUsageQuery = {},
): JevUsageView {
  // summary / byKey / recent 在同一同步只读事务内读取，避免另一进程中途完成调用时
  // 返回互相矛盾的汇总与明细（与记录页列表同一原则）。
  const read = db.transaction(() => {
    const summary = getJevUsageSummary(db);
    const recent = listRecentJevRequests(db, query);
    return {
      summary: {
        ...summary,
        knownCostUsd: formatUsdFromNanos(summary.knownCostNanos),
      },
      byKey: getJevUsageByKey(db).map((row) => ({
        ...row,
        knownCostUsd: formatUsdFromNanos(row.knownCostNanos),
      })),
      recent: { items: recent.items.map(toRequestView), total: recent.total },
    };
  });
  return read();
}
