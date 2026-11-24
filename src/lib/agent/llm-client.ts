import type { OpenAiToolDefinition } from "@/lib/agent/tools/types";

export type Stage2LlmErrorKind =
  | "auth"
  | "rate_limit"
  | "server"
  | "network"
  | "bad_request"
  | "invalid_response";

export class Stage2LlmError extends Error {
  readonly kind: Stage2LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    kind: Stage2LlmErrorKind,
    message: string,
    options: { status?: number; retryable: boolean } = { retryable: false },
  ) {
    super(message);
    this.name = "Stage2LlmError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable;
  }
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
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const cleaned = baseUrl.trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/chat/completions")) return cleaned;
  if (cleaned.endsWith("/v1")) return `${cleaned}/chat/completions`;
  return `${cleaned}/v1/chat/completions`;
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
      if (res.status === 401 || res.status === 403) {
        throw new Stage2LlmError(
          "auth",
          `二级 LLM 鉴权失败（HTTP ${res.status}）`,
          { status: res.status, retryable: false },
        );
      }
      if (res.status === 429) {
        throw new Stage2LlmError(
          "rate_limit",
          `二级 LLM 触发限流（HTTP 429）`,
          { status: 429, retryable: true },
        );
      }
      if (res.status >= 500) {
        throw new Stage2LlmError(
          "server",
          `二级 LLM 服务端错误（HTTP ${res.status}）: ${rawText.slice(0, 200)}`,
          { status: res.status, retryable: true },
        );
      }
      throw new Stage2LlmError(
        "bad_request",
        `二级 LLM 请求被拒绝（HTTP ${res.status}）: ${rawText.slice(0, 200)}`,
        { status: res.status, retryable: false },
      );
    }

    let data: {
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    try {
      data = JSON.parse(rawText) as typeof data;
    } catch {
      throw new Stage2LlmError(
        "invalid_response",
        "二级 LLM 返回了非 JSON 响应",
        { retryable: true },
      );
    }

    const choiceMsg = data.choices?.[0]?.message;
    if (!choiceMsg) {
      throw new Stage2LlmError(
        "invalid_response",
        "二级 LLM 响应缺少 choices[0].message",
        { retryable: true },
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
      inputTokens:
        typeof data.usage?.prompt_tokens === "number"
          ? data.usage.prompt_tokens
          : null,
      outputTokens:
        typeof data.usage?.completion_tokens === "number"
          ? data.usage.completion_tokens
          : null,
    };
  } catch (err) {
    if (err instanceof Stage2LlmError) throw err;
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new Stage2LlmError(
      "network",
      isAbort
        ? `二级 LLM 请求超时（>${req.timeoutMs}ms）`
        : `二级 LLM 网络异常: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}
