import { describeNetworkFailure } from "@/lib/http/network-error";
import { fetchJev } from "@/lib/jev/transport";
import {
  SystemOneResponseSchema,
  extractUsageFromJson,
  normalizeUsage,
  type JevUsage,
  type SystemOneResponse,
} from "@/lib/jev/types";
import type { JevQuestion } from "@/lib/jev/prompt";

/**
 * TypeSafe Jev 原生 System One 客户端。
 *
 * `POST {baseUrl}/v1/systemone`，Bearer API 密钥只在服务端使用；
 * body 为 `{ state, model, questions }`。超时 / HTTP 非 2xx / JSON 解析失败
 * 抛类型化 `JevError`，由调用方记录为「处理失败」并有限重试，绝不伪造命中。
 *
 * 适配器只负责传输与响应边界，**不做** Key 选择、失败计数或账本：
 * - 成功时返回归一化 usage / 响应 model / `x-typesafe-request-id`；
 * - 失败时把可核实的用量与 request id 挂在 `JevError` 上，便于调用方记账；
 * - 非 2xx 只从明确符合 usage 契约的字段读取用量，其他正文不能冒充用量。
 */

export const DEFAULT_JE_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JE_MODEL = "jev-latest";
export const DEFAULT_JE_TIMEOUT_MS = 20000;

/** 网络层失败 / 429 / 529 但没有 Retry-After 时的有限指数退避基准。 */
export const JE_RATE_LIMIT_BASE_BACKOFF_MS = 30_000;
export const JE_RATE_LIMIT_MAX_BACKOFF_MS = 300_000;

export class JevError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  /** 机器可读的错误分类，用于区分"配置问题（可自动恢复）"与"数据/结构问题"。 */
  readonly code: string | null;
  /** 上游 Retry-After 解析出的毫秒数（仅 429/529 等可能带）。 */
  readonly retryAfterMs: number | null;
  /** 上游 `x-typesafe-request-id`，用于对账；失败时也可能存在。 */
  readonly upstreamRequestId: string | null;
  /** 响应体报告的模型版本（可能缺失）。 */
  readonly responseModel: string | null;
  /** 失败响应中可核实的用量；不可核实则为全 null。 */
  readonly usage: JevUsage;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      code?: string | null;
      retryAfterMs?: number | null;
      upstreamRequestId?: string | null;
      responseModel?: string | null;
      usage?: JevUsage;
    } = {},
  ) {
    super(message);
    this.name = "JevError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? true;
    this.code = options.code ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.upstreamRequestId = options.upstreamRequestId ?? null;
    this.responseModel = options.responseModel ?? null;
    this.usage = options.usage ?? { inputTokens: null, outputTokens: null };
  }
}

/** Jev 错误分类：这两类属于配置问题，用户配置正确后应能自动恢复。 */
export const JE_CONFIG_ERROR_CODES = new Set(["not_configured", "auth"]);

export interface SystemOneRequest {
  state: string;
  model: string;
  questions: Record<string, JevQuestion>;
}

/**
 * 把网络层失败翻译成中文、可操作的信息（实现见 lib/http/network-error.ts）。
 * 原始异常只写入服务端日志。
 */
export function describeJevNetworkFailure(
  error: unknown,
  baseUrl: string,
  timeoutMs: number,
): string {
  return describeNetworkFailure(error, {
    service: "Jev 服务",
    target: baseUrl,
    timeoutMs,
    timeoutHint: "请检查服务地址与网络，或在页面调大超时时间",
    unreachableHint: "请检查服务地址、NAS 出网与代理设置",
  });
}

/**
 * 解析 `Retry-After` 响应头为毫秒数。
 * 支持两种官方形式：秒数（整数）或 HTTP 日期。无法解析返回 null。
 */
export function parseRetryAfterMs(
  header: string | null,
  now: Date = new Date(),
): number | null {
  if (!header) return null;
  const value = header.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  const diff = ms - now.getTime();
  return diff > 0 ? diff : 0;
}

export interface JevClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface JevCallOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export async function callSystemOne(
  config: JevClientConfig,
  request: SystemOneRequest,
  options: JevCallOptions = {},
): Promise<SystemOneResponse> {
  const fetchImpl = options.fetchImpl ?? fetchJev;
  const timeoutMs = config.timeoutMs ?? DEFAULT_JE_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
    : AbortSignal.timeout(timeoutMs);

  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    console.error("[jev] 调用失败：", error);
    throw new JevError(
      describeJevNetworkFailure(error, config.baseUrl, timeoutMs),
      { retryable: true, code: "network" },
    );
  }

  const upstreamRequestId = response.headers.get("x-typesafe-request-id");
  const retryAfterMs = parseRetryAfterMs(
    response.headers.get("retry-after"),
    options.now?.() ?? new Date(),
  );
  const text = await response.text();

  if (!response.ok) {
    // 非 2xx：只从明确符合 usage 契约的字段读取用量，其他正文不能冒充。
    let errorUsage: JevUsage = { inputTokens: null, outputTokens: null };
    let responseModel: string | null = null;
    try {
      const json: unknown = JSON.parse(text);
      errorUsage = extractUsageFromJson(json);
      const model = (json as { model?: unknown } | null)?.model;
      if (typeof model === "string" && model.trim()) responseModel = model.trim();
    } catch {
      // 错误体不是 JSON：用量/模型保持未知。
    }
    const isAuthError = response.status === 401 || response.status === 403;
    throw new JevError(`Jev 返回 HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
      code: isAuthError ? "auth" : null,
      retryAfterMs,
      upstreamRequestId,
      responseModel,
      usage: errorUsage,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevError("Jev 响应不是合法 JSON", {
      code: "invalid_response",
      status: response.status,
      retryable: false,
      retryAfterMs,
      upstreamRequestId,
    });
  }

  const parsed = SystemOneResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new JevError("Jev 响应结构不符合预期", {
      code: "invalid_response",
      status: response.status,
      retryable: false,
      retryAfterMs,
      upstreamRequestId,
      // 结构不合法时仍保留响应中可核实的用量与模型，避免漏记已发生的输入费用。
      responseModel:
        typeof (json as { model?: unknown }).model === "string"
          ? ((json as { model: string }).model.trim() || null)
          : null,
      usage: extractUsageFromJson(json),
    });
  }

  const rawModel = parsed.data.model;
  return {
    model: typeof rawModel === "string" && rawModel.trim() ? rawModel.trim() : null,
    answers: parsed.data.answers,
    usage: normalizeUsage(parsed.data.usage),
    upstreamRequestId,
    httpStatus: response.status,
  };
}

export interface JevTestResult {
  ok: boolean;
  message: string;
}

/** 连接测试用的最小 Choice 问题（只验证接口可达与结构可解析）。 */
export function buildConnectivityRequest(model: string): SystemOneRequest {
  return {
    state: JSON.stringify({ 线报标题: "连接测试" }),
    model,
    questions: {
      connectivity: {
        type: "choice",
        criteria: {
          matched: "状态明确可判定。",
          not_matched: "状态明确不可判定。",
          uncertain: "无法判断。",
        },
        instructions: "请选择 matched 以确认连接正常。",
      },
    },
  };
}

/** 校验连接测试响应是否含可解析的 answers。 */
export function evaluateConnectivityResponse(response: SystemOneResponse): JevTestResult {
  const answers = response.answers;
  if (!answers || typeof answers !== "object") {
    return { ok: false, message: "Jev 返回中缺少 answers 字段" };
  }
  return { ok: true, message: "Jev 连接测试成功（仅验证接口可达与结构可解析）" };
}

/**
 * 单次连接测试：只发一个最小 Choice 问题，不触发任何历史回放。
 *
 * **不再吞错**：网络/HTTP/结构异常按类型抛出，由上层统一服务先完成账本与失败计数，
 * 再转换为中文结果；否则会丢掉错误分类，导致用量与失败计数漏记。
 */
export async function testJevConnection(
  config: JevClientConfig,
  options: JevCallOptions = {},
): Promise<JevTestResult> {
  const response = await callSystemOne(
    config,
    buildConnectivityRequest(config.model),
    options,
  );
  return evaluateConnectivityResponse(response);
}
