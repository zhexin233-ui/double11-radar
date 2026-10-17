/** 前端使用的 API 响应类型（与 src/lib 的领域类型保持一致，客户端不依赖服务端模块）。 */

/** 服务端分页响应：一页条目 + 总数。 */
export interface PagedItems<T> {
  items: T[];
  total: number;
}

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
    evaluationMode: EvaluationModeDto;
    regexRules: string[];
  };
  apiKey: SecretStateDto;
  version: number;
}

/** 后台自动处理模式（与 lib/domain/types 的 EvaluationMode 一致）。 */
export type EvaluationModeDto = "individual" | "batch_gate" | "regex_gate";

export const EVALUATION_MODE_LABELS: Record<EvaluationModeDto, string> = {
  individual: "逐条判断（默认）",
  batch_gate: "批次预筛后逐条判断",
  regex_gate: "正则预筛后逐条判断",
};

/** 三模式选择项（含取舍说明）。 */
export const EVALUATION_MODE_OPTIONS: ReadonlyArray<{
  value: EvaluationModeDto;
  label: string;
  description: string;
}> = [
  {
    value: "individual",
    label: EVALUATION_MODE_LABELS.individual,
    description:
      "每条新线报都对全部启用需求调用一次 JEV，保留完整语义判断。没有额外预筛，不会因预筛漏判。",
  },
  {
    value: "batch_gate",
    label: EVALUATION_MODE_LABELS.batch_gate,
    description:
      "先对一批新线报做一次整体初筛：全部明确无关时节省调用；有命中或可疑时该批所有成员逐条判断，会多一次预筛调用。合成判断可能漏判，属可选模式的取舍。",
  },
  {
    value: "regex_gate",
    label: EVALUATION_MODE_LABELS.regex_gate,
    description:
      "先用下方全局正则预筛，命中才逐条调用 JEV；规则未覆盖的线报会直接跳过，可能漏报，需维护规则。",
  },
];

/** 正则规则保护上限（与服务端 constants 一致，仅作输入提示）。 */
export const MAX_REGEX_RULES = 20;
export const MAX_REGEX_RULE_LENGTH = 500;
export const MAX_REGEX_TOTAL_BYTES = 16 * 1024;

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

export type JevRequestPurposeDto = "evaluate" | "batch_gate" | "test" | "dry_run";
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
  evaluationRunId: string | null;
  batchPartId: string | null;
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
  /** 问题模板版本（rule_version）；追溯与「是否为当前规则」判断用。 */
  ruleVersion: string;
  /** 落库时的 Jev 配置版本；与调用账本一致，供追溯。 */
  configVersion: number;
  result: EvaluationResultDto;
  probabilities: string | null;
  confidence: number | null;
  error: string | null;
  updatedAt: string;
  /** 模型原始三态选择；解析失败或旧记录（策略未记录）为 null。 */
  modelResult: ChoiceOutcomeDto | null;
  /** 程序判定原因码；旧记录为 null。 */
  decisionReason: DecisionReasonDto | null;
  /** 匹配确认策略版本；旧记录为 null（不伪称已应用新策略）。 */
  decisionPolicyVersion: string | null;
  decisionPolicy: MatchConfirmationPolicyDto | null;
  /** 触发该判断的实际调用账本 ID；旧记录为 null。 */
  jevRequestId: string | null;
}

export type ChoiceOutcomeDto = "matched" | "not_matched" | "uncertain";
export type EvaluationResultDto = ChoiceOutcomeDto | "failed";

/** 匹配确认的确定性程序原因码（与 lib/domain/types 的 DecisionReason 镜像）。 */
export type DecisionReasonDto =
  | "parse_failed"
  | "model_not_matched"
  | "model_uncertain"
  | "probabilities_missing"
  | "probabilities_invalid"
  | "choice_probability_conflict"
  | "matched_probability_below_threshold"
  | "matched_confirmed";

/** 匹配确认策略快照（与 lib/domain/types 的 MatchConfirmationPolicy 镜像）。 */
export interface MatchConfirmationPolicyDto {
  minMatchedProbability: number;
  probabilitySumTolerance: number;
}

/** 触发降级的固定文案（需带分数/门槛时用 `formatDecisionReason`）。 */
export const DECISION_REASON_LABELS: Record<DecisionReasonDto, string> = {
  parse_failed: "解析失败，未形成有效模型选择",
  model_not_matched: "模型判定不匹配（不提升为匹配）",
  model_uncertain: "模型信息不足",
  probabilities_missing: "模型选择匹配但缺少概率分布，已降为待确认",
  probabilities_invalid: "概率分布不完整或不合法，已降为待确认",
  choice_probability_conflict: "匹配概率低于其它选项，已降为待确认",
  matched_probability_below_threshold: "匹配概率低于自动确认门槛，已降为待确认",
  matched_confirmed: "通过匹配确认门槛",
};

/** 模型原始选择的中文标签（与业务结果分开显示）。 */
export const MODEL_CHOICE_LABELS: Record<ChoiceOutcomeDto, string> = {
  matched: "匹配",
  not_matched: "不匹配",
  uncertain: "信息不足",
};

/**
 * 格式化程序判定原因。低于门槛时使用保存的原始分数与实际门槛，
 * 不用显示舍入值重新决策。
 */
export function formatDecisionReason(
  reason: DecisionReasonDto,
  values: {
    matchedProbability?: number | null;
    minMatchedProbability?: number | null;
  } = {},
): string {
  if (reason === "matched_probability_below_threshold") {
    const { matchedProbability, minMatchedProbability } = values;
    if (
      typeof matchedProbability === "number" &&
      typeof minMatchedProbability === "number"
    ) {
      return `匹配概率 ${matchedProbability} 低于自动确认门槛 ${minMatchedProbability}，已降为待确认`;
    }
  }
  return DECISION_REASON_LABELS[reason];
}

/** 置信度展示；缺失为 —，越界值明确标为异常（不冒充有效置信度）。 */
export function formatConfidence(confidence: number | null): string {
  if (confidence === null) return "—";
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return `上游置信度异常（原值 ${confidence}）`;
  }
  return String(confidence);
}

/** 解析持久化概率 JSON 字符串；非法为空，不伪造概率。 */
export function parseProbabilityRecord(
  raw: string | null,
): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

/** 概率分布展示；缺失为 —。 */
export function formatProbabilities(
  value: Record<string, number> | null,
): string {
  if (!value) return "—";
  return Object.entries(value)
    .map(([key, score]) => `${key}=${score}`)
    .join("，");
}

/** 本地处理阶段（不伪造模型答案）。 */
export type ProcessingStageDto =
  | "pending"
  | "ready"
  | "filtered"
  | "evaluated"
  | "failed"
  | "skipped_no_needs";

/** 本地过滤来源。 */
export type ScreeningSourceDto = "batch_gate" | "regex_gate";

export const PROCESSING_SOURCE_LABELS: Record<ScreeningSourceDto, string> = {
  batch_gate: "批次预筛排除",
  regex_gate: "正则过滤",
};

/** 线报的处理策略 / 批次 / 过滤来源元数据（详情展示，不代表模型概率）。 */
export interface BulletinProcessingDto {
  runId: string;
  evaluationMode: EvaluationModeDto;
  stage: ProcessingStageDto;
  screeningSource: ScreeningSourceDto | null;
  screeningReason: string | null;
  gateRequestId: string | null;
  matchedRuleIndex: number | null;
  batchPartId: string | null;
  /** 批次需求快照名称（batch_gate）；其它模式为 null。 */
  needSnapshotNames: string[] | null;
  /** 正则规则条数（regex_gate）；其它模式为 null。 */
  regexRuleCount: number | null;
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
  /** 已有通知（若有）：用于区分「本次待确认」与「从未发送过」。 */
  notification: { id: string; createdAt: string } | null;
  /** 是否存在未按当前策略重算的历史 matched；详情据此提示。 */
  hasHistoricalMatched: boolean;
  /** 三模式处理元数据；旧数据 / 基线为 null。 */
  processing: BulletinProcessingDto | null;
}

export interface DryRunNeedResultDto {
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  result: EvaluationResultDto;
  modelResult: ChoiceOutcomeDto | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  decisionReason: DecisionReasonDto;
  decisionPolicyVersion: string;
  decisionPolicy: MatchConfirmationPolicyDto;
  jevRequestId: string;
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
  uncertain: "待确认",
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

/** 需求清单每页条数（与服务端默认一致）。 */
export const NEEDS_PAGE_SIZE = 10;

/** 采集频道每页条数（与服务端默认一致）。 */
export const CHANNELS_PAGE_SIZE = 20;

/** 记录页自动刷新间隔（毫秒）；默认关闭，由用户显式开启。 */
export const BULLETIN_AUTO_REFRESH_MS = 5000;

export const DELIVERY_LABELS: Record<DeliveryDto["status"], string> = {
  pending: "待发送",
  sending: "发送中",
  succeeded: "已成功",
  failed: "失败（可重试）",
  disabled: "已停用/需人工处理",
};

/**
 * 聚合计数里的投递状态 → 中文标签。
 *
 * 状态计数来自服务端的 `GROUP BY status`，类型上只是一个字符串：
 * 未知值原样返回（不伪造标签，也不假装它是已知状态）。
 */
export function deliveryLabel(status: string): string {
  return Object.hasOwn(DELIVERY_LABELS, status)
    ? DELIVERY_LABELS[status as DeliveryDto["status"]]
    : status;
}

export const EVALUATION_LABELS: Record<EvaluationDto["result"], string> = {
  matched: "匹配",
  not_matched: "不匹配",
  uncertain: "待确认",
  failed: "处理失败",
};
