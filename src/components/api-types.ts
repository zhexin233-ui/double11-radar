/** 前端使用的 API 响应类型（与 src/lib 的领域类型保持一致，客户端不依赖服务端模块）。 */

export interface NeedDto {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDto {
  id: string;
  name: string;
  origin: "feed" | "zdm";
  alias: string | null;
  available: boolean;
  selected: boolean;
  initialized: boolean;
  cacheTtlSeconds: number;
  nextPollAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface ChannelSelectionDto {
  mode: "all" | "custom";
  customIds: string[];
}

export interface ChannelStatsDto {
  total: number;
  selected: number;
  initialized: number;
  failing: number;
}

export interface SecretStateDto {
  configured: boolean;
  masked: string | null;
  /** 已配置但当前加密密钥无法解密（例如 APP_ENCRYPTION_KEY 已变更）。 */
  unreadable: boolean;
}

export interface JevConfigDto {
  config: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    concurrency: number;
    jobsPerRound: number;
  };
  apiKey: SecretStateDto;
  version: number;
}

/**
 * 并发与每轮任务数的界面提示边界。
 * 服务端是唯一权威（会校验并 clamp），这里只用于输入框提示，不做业务判断。
 */
export const JE_CONCURRENCY_RANGE = { min: 1, max: 8 } as const;
export const JE_JOBS_PER_ROUND_RANGE = { min: 1, max: 50 } as const;

/** 单个 Jev API Key 的展示状态（绝不含明文密钥）。 */
export interface JevKeyDto {
  id: string;
  label: string;
  generation: number;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  secretState: SecretStateDto;
}

/** `/api/settings/jev` 的完整响应：基础配置 + 兼容掩码 + Key 列表。 */
export interface JevSettingsDto extends JevConfigDto {
  keys: JevKeyDto[];
}

/** 连续失败达到该次数会自动禁用 Key（与服务端常量一致）。 */
export const JE_KEY_FAILURE_THRESHOLD = 3;

export type JevRequestPurposeDto = "evaluate" | "test" | "dry_run";
export type JevRequestStatusDto =
  | "in_flight"
  | "succeeded"
  | "failed"
  | "interrupted";
export type JevCostStatusDto = "known" | "unknown";

export interface JevUsageRequestDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  purpose: JevRequestPurposeDto;
  purposeLabel: string;
  status: JevRequestStatusDto;
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
  costStatus: JevCostStatusDto;
  unknownReason: string | null;
  estimatedUsdNanos: number | null;
  /** 已知费用的格式化美元字符串；未知为 null（不能显示为 $0.00）。 */
  estimatedUsd: string | null;
  priceVersion: string | null;
}

export interface JevUsageSummaryDto {
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

export interface JevUsageByKeyDto {
  keyId: string | null;
  keyLabel: string | null;
  requestCount: number;
  /** 已计价调用数；`in_flight` 不计入（它既不是已计价也不是「费用未知」）。 */
  knownRequestCount: number;
  knownCostNanos: number;
  knownCostUsd: string;
  unknownCostCount: number;
  inputTokens: number;
  outputTokens: number;
  failedCount: number;
}

export interface JevUsageDto {
  summary: JevUsageSummaryDto;
  byKey: JevUsageByKeyDto[];
  recent: { items: JevUsageRequestDto[]; total: number };
}

export interface NotifyConfigDto {
  config: {
    bark: { enabled: boolean; serverUrl: string };
    feishu: { enabled: boolean; keywordPrefix: string; signingEnabled: boolean };
  };
  bark: { deviceKey: SecretStateDto };
  feishu: { webhook: SecretStateDto; signingSecret: SecretStateDto };
  version: number;
}

export interface EvaluationDto {
  id: string;
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  result: "matched" | "not_matched" | "uncertain" | "failed";
  probabilities: string | null;
  confidence: number | null;
  error: string | null;
  updatedAt: string;
}

export interface DeliveryDto {
  id: string;
  channel: "bark" | "feishu";
  status: "pending" | "sending" | "succeeded" | "failed" | "disabled";
  attempts: number;
  httpStatus: number | null;
  bizCode: string | null;
  error: string | null;
  updatedAt: string;
}

export interface BulletinDetailDto {
  bulletin: {
    id: string;
    title: string;
    url: string;
    content: string | null;
    category: string | null;
    price: number | null;
    brand: string | null;
    mall: string | null;
    sourceNs: string;
    publishedAt: string | null;
    baseline: boolean;
  };
  status: "baseline" | "pending" | "matched" | "failed" | "uncertain" | "not_matched";
  matchedNeeds: string[];
  explanation: string | null;
  evaluations: EvaluationDto[];
  deliveries: DeliveryDto[];
}

export interface DryRunNeedResultDto {
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  result: "matched" | "not_matched" | "uncertain" | "failed";
  probabilities: Record<string, number> | null;
  confidence: number | null;
  error: string | null;
}

export interface DryRunResultDto {
  configVersion: number;
  model: string;
  ruleVersion: string;
  needsCount: number;
  results: DryRunNeedResultDto[];
}

export interface StatusDto {
  worker: {
    workerStartedAt: string | null;
    lastHeartbeatAt: string | null;
    lastCollectAt: string | null;
    lastEvaluateAt: string | null;
    lastDeliverAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    lastErrorStage: string | null;
    rateLimitBackoffUntil: string | null;
    rateLimitRemaining: number | null;
    rateLimitResetAt: string | null;
    heartbeatFresh: boolean;
    running: boolean;
  };
  channels: {
    stats: ChannelStatsDto;
    failing: Array<{
      id: string;
      name: string;
      lastError: string | null;
      lastErrorAt: string | null;
    }>;
  };
  jobs: { pending: number; leased: number; dead: number };
  counts: {
    matchedBulletins: number;
    uncertainBulletins: number;
    failedEvaluations: number;
    notificationCount: number;
    delivery: Record<string, number>;
    lastMatchedAt: string | null;
  };
  processingHealthy: boolean;
  recentFailedJobs: Array<{
    id: string;
    kind: string;
    status: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
  }>;
}

export interface TestResultDto {
  ok: boolean;
  message?: string;
  httpStatus?: number | null;
  bizCode?: string | null;
  error?: string | null;
}

export const STATUS_LABELS: Record<BulletinDetailDto["status"], string> = {
  baseline: "已建立基线",
  pending: "等待判断",
  matched: "明确匹配",
  uncertain: "待确认（信息不足）",
  failed: "处理失败",
  not_matched: "没有匹配",
};

/** 记录页状态筛选值（空串=全部；基线不在筛选范围内）。 */
export type BulletinFilterStatusDto =
  | "pending"
  | "matched"
  | "uncertain"
  | "failed"
  | "not_matched";

/** 记录页筛选下拉选项：全部 + 五种非基线状态。 */
export const BULLETIN_FILTER_OPTIONS: ReadonlyArray<{
  value: "" | BulletinFilterStatusDto;
  label: string;
}> = [
  { value: "", label: "全部" },
  { value: "pending", label: STATUS_LABELS.pending },
  { value: "matched", label: STATUS_LABELS.matched },
  { value: "uncertain", label: STATUS_LABELS.uncertain },
  { value: "failed", label: STATUS_LABELS.failed },
  { value: "not_matched", label: STATUS_LABELS.not_matched },
];

/** 记录页每页条数（与服务端默认一致）。 */
export const BULLETIN_PAGE_SIZE = 50;

/** 记录页自动刷新间隔（毫秒）；默认关闭，由用户显式开启。 */
export const BULLETIN_AUTO_REFRESH_MS = 5000;

export const DELIVERY_LABELS: Record<DeliveryDto["status"], string> = {
  pending: "待发送",
  sending: "发送中",
  succeeded: "已成功",
  failed: "失败（可重试）",
  disabled: "已停用/需人工处理",
};

export const EVALUATION_LABELS: Record<EvaluationDto["result"], string> = {
  matched: "匹配",
  not_matched: "不匹配",
  uncertain: "信息不足",
  failed: "处理失败",
};
