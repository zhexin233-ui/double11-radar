import type { OpenAiToolDefinition } from "@/lib/agent/tools/types";
import { parseTokenCount } from "@/lib/jev/pricing";

export type Stage2LlmErrorKind =
  | "auth"
  | "rate_limit"
  | "server"
  | "network"
  | "bad_request"
  | "invalid_response";

export interface Stage2LlmErrorOptions {
  status?: number;
  retryable: boolean;
  responseModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  isTimeout?: boolean;
}

export class Stage2LlmError extends Error {
  readonly kind: Stage2LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly responseModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly isTimeout: boolean;

  constructor(
    kind: Stage2LlmErrorKind,
    message: string,
    options: Stage2LlmErrorOptions = { retryable: false },
  ) {
    super(message);
    this.name = "Stage2LlmError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable;
    this.responseModel = options.responseModel ?? null;
    this.inputTokens = options.inputTokens ?? null;
    this.outputTokens = options.outputTokens ?? null;
    this.isTimeout = options.isTimeout === true;
  }
}

export interface SafeStage2LedgerError {
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
}

/**
 * 将二级调用异常映射为白名单安全错误码与固定中文分类文案。
 * 绝不把含上游原始正文的 `Stage2LlmError.message` 或网络底层异常原文写入账本。
 */
export function sanitizeStage2LedgerError(
  error: unknown,
): SafeStage2LedgerError {
  if (error instanceof Stage2LlmError) {
    const httpStatus = typeof error.status === "number" ? error.status : null;
    switch (error.kind) {
      case "auth":
        return { errorCode: "auth", errorMessage: "二级模型鉴权失败", httpStatus };
      case "rate_limit":
        return {
          errorCode: "rate_limit",
          errorMessage: "二级模型触发限流",
          httpStatus,
        };
      case "server":
        return {
          errorCode: "server",
          errorMessage: "二级模型服务端错误",
          httpStatus,
        };
      case "bad_request":
        return {
          errorCode: "bad_request",
          errorMessage: "二级模型请求被拒绝",
          httpStatus,
        };
      case "invalid_response":
        return {
          errorCode: "invalid_response",
          errorMessage: "二级模型返回结构异常",
          httpStatus,
        };
      case "network":
        return error.isTimeout
          ? {
              errorCode: "timeout",
              errorMessage: "二级模型请求超时",
              httpStatus: null,
            }
          : {
              errorCode: "network",
              errorMessage: "二级模型网络连接失败",
              httpStatus: null,
            };
    }
  }
  return {
    errorCode: "unknown",
    errorMessage: "二级模型调用失败",
    httpStatus: null,
  };
}

export interface ChatToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  messages: ChatMessage[];
  tools?: OpenAiToolDefinition[];
  toolChoice?: "auto" | "none";
  fetchImpl?: typeof fetch;
}

export interface ChatCompletionResponse {
  content: string | null;
  toolCalls: ChatToolCall[];
  inputTokens: number | null;
  outputTokens: number | null;
  responseModel: string | null;
  httpStatus: number;
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/chat/completions")) return cleaned;
  if (cleaned.endsWith("/v1")) return `${cleaned}/chat/completions`;
  return `${cleaned}/v1/chat/completions`;
}

interface SafeOpenAiMeta {
  responseModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function extractSafeOpenAiMetaFromObject(parsed: unknown): SafeOpenAiMeta {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { responseModel: null, inputTokens: null, outputTokens: null };
  }
  const obj = parsed as { model?: unknown; usage?: unknown };
  const responseModel =
    typeof obj.model === "string" && obj.model.trim()
      ? obj.model.trim().slice(0, 200)
      : null;

  const usageObj =
    obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage)
      ? (obj.usage as {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
        })
      : null;

  const inputTokens = parseTokenCount(
    usageObj?.prompt_tokens !== undefined
      ? usageObj.prompt_tokens
      : usageObj?.input_tokens,
  );
  const outputTokens = parseTokenCount(
    usageObj?.completion_tokens !== undefined
      ? usageObj.completion_tokens
      : usageObj?.output_tokens,
  );

  return { responseModel, inputTokens, outputTokens };
}

function extractSafeOpenAiMetaFromText(rawText: string): SafeOpenAiMeta {
  try {
    return extractSafeOpenAiMetaFromObject(JSON.parse(rawText) as unknown);
  } catch {
    return { responseModel: null, inputTokens: null, outputTokens: null };
  }
}

export async function callOpenAiChatCompletion(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const fetchFn = req.fetchImpl ?? fetch;
  const url = resolveChatCompletionsUrl(req.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);

  try {
    const payload: Record<string, unknown> = {
      model: req.model,
      temperature: req.temperature,
      messages: req.messages,
    };

    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools;
      payload.tool_choice = req.toolChoice ?? "auto";
    } else if (req.toolChoice === "none") {
      // 无 tools 时不传 tool_choice，兼容部分严格校验的 OpenAI-Compatible 网关
    }

    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawText = await res.text();

    if (!res.ok) {
      const meta = extractSafeOpenAiMetaFromText(rawText);
      if (res.status === 401 || res.status === 403) {
        throw new Stage2LlmError(
          "auth",
          `二级 LLM 鉴权失败（HTTP ${res.status}）`,
          { status: res.status, retryable: false, ...meta },
        );
      }
      if (res.status === 429) {
        throw new Stage2LlmError(
          "rate_limit",
          `二级 LLM 触发限流（HTTP 429）`,
          { status: 429, retryable: true, ...meta },
        );
      }
      if (res.status >= 500) {
        throw new Stage2LlmError(
          "server",
          `二级 LLM 服务端错误（HTTP ${res.status}）: ${rawText.slice(0, 200)}`,
          { status: res.status, retryable: true, ...meta },
        );
      }
      throw new Stage2LlmError(
        "bad_request",
        `二级 LLM 请求被拒绝（HTTP ${res.status}）: ${rawText.slice(0, 200)}`,
        { status: res.status, retryable: false, ...meta },
      );
    }

    let data: {
      model?: unknown;
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
      };
    };

    try {
      data = JSON.parse(rawText) as typeof data;
    } catch {
      throw new Stage2LlmError(
        "invalid_response",
        "二级 LLM 返回了非 JSON 响应",
        { status: res.status, retryable: true },
      );
    }

    // 在校验对话内容之前提取安全响应元数据，确保结构异常时仍保留可核实的模型与 Token 用量。
    const meta = extractSafeOpenAiMetaFromObject(data);

    const choiceMsg = data.choices?.[0]?.message;
    if (!choiceMsg) {
      throw new Stage2LlmError(
        "invalid_response",
        "二级 LLM 响应缺少 choices[0].message",
        { status: res.status, retryable: true, ...meta },
      );
    }

    const toolCalls: ChatToolCall[] = Array.isArray(choiceMsg.tool_calls)
      ? choiceMsg.tool_calls
          .filter((tc) => Boolean(tc?.function?.name))
          .map((tc, idx) => ({
            id: tc.id ?? `call_${idx}`,
            name: tc.function!.name!,
            argumentsRaw: tc.function!.arguments ?? "{}",
          }))
      : [];

    return {
      content: typeof choiceMsg.content === "string" ? choiceMsg.content : null,
      toolCalls,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      responseModel: meta.responseModel,
      httpStatus: res.status,
    };
  } catch (err) {
    if (err instanceof Stage2LlmError) throw err;
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new Stage2LlmError(
      "network",
      isAbort
        ? `二级 LLM 请求超时（>${req.timeoutMs}ms）`
        : `二级 LLM 网络异常: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, isTimeout: isAbort },
    );
  } finally {
    clearTimeout(timer);
  }
}
