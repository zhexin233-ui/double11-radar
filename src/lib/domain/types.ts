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

/** 任务状态。`leased` 为租约持有中，`dead` 为超过最大尝试次数。 */
export type JobStatus = "pending" | "leased" | "succeeded" | "dead";

/** 后台任务种类。 */
export type JobKind = "evaluate" | "deliver";

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

/** 管理员会话记录（token 只存哈希）。 */
export interface SessionRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}
