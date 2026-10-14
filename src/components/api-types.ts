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
  config: { baseUrl: string; model: string; timeoutMs: number };
  apiKey: SecretStateDto;
  version: number;
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
