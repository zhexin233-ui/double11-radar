import { describeNetworkFailure } from "@/lib/http/network-error";
import {
  SystemOneResponseSchema,
  type SystemOneResponse,
} from "@/lib/jev/types";
import type { JevQuestion } from "@/lib/jev/prompt";

/**
 * TypeSafe Jev 原生 System One 客户端。
 *
 * `POST {baseUrl}/v1/systemone`，Bearer API 密钥只在服务端使用；
 * body 为 `{ state, model, questions }`。超时 / HTTP 非 2xx / JSON 解析失败
 * 抛类型化 `JevError`，由调用方记录为「处理失败」并有限重试，绝不伪造命中。
 */

export const DEFAULT_JE_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_JE_MODEL = "jev-latest";
export const DEFAULT_JE_TIMEOUT_MS = 20000;

export class JevError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  /** 机器可读的错误分类，用于区分"配置问题（可自动恢复）"与"数据/结构问题"。 */
  readonly code: string | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      code?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "JevError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? true;
    this.code = options.code ?? null;
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

export interface JevClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface JevCallOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function callSystemOne(
  config: JevClientConfig,
  request: SystemOneRequest,
  options: JevCallOptions = {},
): Promise<SystemOneResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
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
      { retryable: true },
    );
  }

  const text = await response.text();
  if (!response.ok) {
    const isAuthError = response.status === 401 || response.status === 403;
    throw new JevError(`Jev 返回 HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
      code: isAuthError ? "auth" : null,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevError("Jev 响应不是合法 JSON", {
      status: response.status,
      retryable: false,
    });
  }

  const parsed = SystemOneResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new JevError("Jev 响应结构不符合预期", {
      status: response.status,
      retryable: false,
    });
  }
  return parsed.data;
}

export interface JevTestResult {
  ok: boolean;
  message: string;
}

/**
 * 单次连接测试：只发一个最小 Choice 问题，不触发任何历史回放。
 * 返回清洗后的结果，不回传可能含凭据的完整请求/响应。
 */
export async function testJevConnection(
  config: JevClientConfig,
  options: JevCallOptions = {},
): Promise<JevTestResult> {
  try {
    const response = await callSystemOne(
      config,
      {
        state: JSON.stringify({ 线报标题: "连接测试" }),
        model: config.model,
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
      },
      options,
    );
    const answers = response.answers;
    if (!answers || typeof answers !== "object") {
      return { ok: false, message: "Jev 返回中缺少 answers 字段" };
    }
    return { ok: true, message: "Jev 连接测试成功（仅验证接口可达与结构可解析）" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}
