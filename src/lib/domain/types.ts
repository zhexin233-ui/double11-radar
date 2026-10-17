/**
 * 共享领域类型。
 *
 * 所有层（采集 / Jev / 通知 / API / 页面 / worker）必须从这里 import，
 * 禁止在消费端对 `unknown` 做局部断言后再定义私有版本。
 */

/** 单次 Jev 判断在三态 Choice 中的结果。 */
export type ChoiceOutcome = "matched" | "not_matched" | "uncertain";

/**
 * 判断记录的持久化结果。
 * `failed` 表示模型调用失败或返回结构不合法，绝不能等同 `uncertain` 或命中。
 */
export type EvaluationResult = ChoiceOutcome | "failed";

/**
 * 匹配确认的确定性程序原因码。
 *
 * 与模型原始选择分开保存：`modelResult` 是模型给出的三态，`result` 是本策略
 * 确认后的业务结果；原因码解释两者为何不同（或为何未变）。
 */
export type DecisionReason =
  | "parse_failed"
  | "model_not_matched"
  | "model_uncertain"
  | "probabilities_missing"
  | "probabilities_invalid"
  | "choice_probability_conflict"
  | "matched_probability_below_threshold"
  | "matched_confirmed";

/** 匹配确认策略参数（随策略版本冻结，改变算法/参数必须提升版本）。 */
export interface MatchConfirmationPolicy {
  /** 自动确认 matched 的最小 p_matched（原始值比较）。 */
  minMatchedProbability: number;
  /** 概率分布总和与 1 的最大可接受误差。 */
  probabilitySumTolerance: number;
}

/** 任务状态。`leased` 为租约持有中，`dead` 为超过最大尝试次数。 */
export type JobStatus = "pending" | "leased" | "succeeded" | "dead";

/**
 * 后台任务种类。
 * - `evaluate`：单条线报对全部启用需求调用一次 JEV；
 * - `screen_batch`：批次初筛，一次整体相关性问题；
 * - `deliver`：通知投递。
 */
export type JobKind = "evaluate" | "screen_batch" | "deliver";

/**
 * 后台自动处理模式（互斥）：
 * - `individual`：逐条判断（默认，兼容旧配置）；
 * - `batch_gate`：批次初筛后全批逐条；
 * - `regex_gate`：全局正则预筛后逐条。
 */
export type EvaluationMode = "individual" | "batch_gate" | "regex_gate";

/** 非基线条目在自动处理链路中的阶段（本地状态，独立于模型 evaluations）。 */
export type ProcessingStage =
  | "pending"
  | "ready"
  | "filtered"
  | "evaluated"
  | "failed"
  | "skipped_no_needs";

/** 本地过滤来源：批次初筛排除 / 正则预筛过滤。 */
export type ScreeningSource = "batch_gate" | "regex_gate";

/** 批次子批状态；门控只能有一个终态。 */
export type BatchPartState = "pending" | "excluded" | "expanded";

/** 单渠道投递状态。 */
export type DeliveryStatus =
  | "pending"
  | "sending"
  | "succeeded"
  | "failed"
  | "disabled";

/** 通知渠道标识。 */
export type NotifyChannel = "bark" | "feishu";

/** 采集来源类型：普通分类流 / 值得买独立流。 */
export type ChannelOrigin = "feed" | "zdm";

/** 频道选择模式。 */
export type ChannelSelectionMode = "all" | "custom";

/** 需求记录。 */
export interface Need {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 采集频道运行时状态。 */
export interface ChannelState {
  id: string;
  name: string;
  kind: string;
  alias: string | null;
  origin: ChannelOrigin;
  available: boolean;
  selected: boolean;
  initialized: boolean;
  cacheTtlSeconds: number;
  nextPollAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 规范化后的线报条目。
 * `price` 缺失必须为 `null`，绝不用 0 代替。
 */
export interface NormalizedBulletin {
  source: string;
  sourceNs: string;
  sourceId: string;
  url: string;
  title: string;
  content: string | null;
  category: string | null;
  price: number | null;
  brand: string | null;
  mall: string | null;
  publishedAt: string | null;
  payload: string;
  contentVersion: string;
}

/** 线报持久化记录。 */
export interface Bulletin {
  id: string;
  source: string;
  sourceNs: string;
  sourceId: string;
  url: string;
  title: string;
  content: string | null;
  category: string | null;
  price: number | null;
  brand: string | null;
  mall: string | null;
  publishedAt: string | null;
  payload: string;
  contentVersion: string;
  baseline: boolean;
  createdAt: string;
}

/** 判断记录（含需求快照，删除需求不破坏历史）。 */
export interface Evaluation {
  id: string;
  bulletinId: string;
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  configVersion: number;
  ruleVersion: string;
  result: EvaluationResult;
  probabilities: string | null;
  confidence: number | null;
  rawAnswer: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** 模型原始三态选择；解析失败或旧记录为 null（不伪称 failed 是模型选择）。 */
  modelResult: ChoiceOutcome | null;
  /** 程序判定原因码；旧记录为 null。 */
  decisionReason: DecisionReason | null;
  /** 匹配确认策略版本；旧记录为 null。 */
  decisionPolicyVersion: string | null;
  /** 匹配确认策略快照；旧记录或快照异常为 null。 */
  decisionPolicy: MatchConfirmationPolicy | null;
  /** 产生该判断的实际调用账本 ID；旧记录为 null。 */
  jevRequestId: string | null;
}

/** 单渠道投递记录。 */
export interface Delivery {
  id: string;
  notificationId: string;
  bulletinId: string;
  channel: NotifyChannel;
  status: DeliveryStatus;
  attempts: number;
  leaseUntil: string | null;
  leaseOwner: string | null;
  httpStatus: number | null;
  bizCode: string | null;
  response: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 一次判断批次对应的通知（一条线报一条通知）。 */
export interface Notification {
  id: string;
  bulletinId: string;
  payload: string;
  createdAt: string;
}

/** 需求快照（冻结当时的名称/备注/版本，删除需求不破坏历史）。 */
export interface NeedSnapshot {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  version: number;
}

/**
 * 一次采集产生的处理 run。
 * 保存采集时的模式、全局规则与（batch_gate 时的）需求快照；
 * 模式/规则变更只作用于之后的新 run，旧 run 继续恢复。
 */
export interface EvaluationRun {
  id: string;
  sourceNs: string;
  evaluationMode: EvaluationMode;
  strategyConfigVersion: number;
  /** regex_gate 的全局规则快照；其它模式为 null。 */
  regexRules: string[] | null;
  /** batch_gate 的需求快照；individual/regex_gate 为 null（执行时取实时需求）。 */
  needSnapshots: NeedSnapshot[] | null;
  createdAt: string;
}

/** batch_gate 的子批；成员由 bulletin_processing.batch_part_id 关联。 */
export interface EvaluationBatchPart {
  id: string;
  runId: string;
  ordinal: number;
  state: BatchPartState;
  gateResult: ChoiceOutcome | null;
  gateRequestId: string | null;
  fallbackReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单个新增线报的本地处理记录（不伪造逐需求 evaluation）。 */
export interface BulletinProcessing {
  bulletinId: string;
  runId: string;
  batchPartId: string | null;
  position: number;
  stage: ProcessingStage;
  screeningSource: ScreeningSource | null;
  screeningReason: string | null;
  gateRequestId: string | null;
  matchedRuleIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 管理员会话记录（token 只存哈希）。 */
export interface SessionRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

// ── Jev 多密钥池与调用账本 ──────────────────────────────────────────────────

/** 一次 Jev 请求的来源。 */
export type JevRequestPurpose =
  | "evaluate"
  | "batch_gate"
  | "test"
  | "dry_run";

/**
 * 调用账本状态。
 * `interrupted` 表示进程中断导致租约过期、尚无真实结果；
 * 迟到的真实响应仍可把它转为 `succeeded`/`failed` 并补写用量一次。
 */
export type JevRequestStatus =
  | "in_flight"
  | "succeeded"
  | "failed"
  | "interrupted";

/** 费用是否可估算。`unknown` 绝不能显示为 $0。 */
export type JevCostStatus = "known" | "unknown";

/** Jev API Key 元数据（密文存 `secrets`，此处只保留非敏感字段）。 */
export interface JevApiKey {
  id: string;
  label: string;
  secretNamespace: string;
  /** 每次替换/手动恢复都会自增；用于隔离旧请求的迟到结果。 */
  generation: number;
  enabled: boolean;
  /** 自动/手动禁用原因（中文，展示给管理员）。 */
  disabledReason: string | null;
  /** 同一 generation 内连续的实际请求失败次数；成功一次清零。 */
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 一次实际 Jev 上游调用的账本记录。 */
export interface JevRequest {
  id: string;
  upstreamRequestId: string | null;
  keyId: string | null;
  keyLabel: string | null;
  keyGeneration: number | null;
  purpose: JevRequestPurpose;
  bulletinId: string | null;
  jobId: string | null;
  /** 所属处理 run（三模式追溯）；旧账本行为 null。 */
  evaluationRunId: string | null;
  /** batch_gate 子批；单条与旧账本行为 null。 */
  batchPartId: string | null;
  requestedModel: string;
  responseModel: string | null;
  providerOrigin: string | null;
  configVersion: number | null;
  status: JevRequestStatus;
  startedAt: string;
  finishedAt: string | null;
  leaseUntil: string | null;
  /** 真实结果完成时刻；非空表示该行已记账、不会被二次累计。 */
  resultRecordedAt: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  priceVersion: string | null;
  inputRateNanosPerToken: number | null;
  estimatedUsdNanos: number | null;
  costStatus: JevCostStatus;
  unknownReason: string | null;
}
