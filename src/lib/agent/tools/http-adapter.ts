import type { HttpApiToolConfig, Stage2ToolRecord } from "@/lib/domain/types";
import type { RegisteredTool, ToolExecutionOutcome } from "@/lib/agent/tools/types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 12_288;

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return `${sliced}\n...[已截断，原始长度 ${buf.byteLength} 字节]`;
}

function isInfraHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export async function callHttpApiTool(
  config: HttpApiToolConfig,
  token: string | null,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<ToolExecutionOutcome> {
  const fetchFn = fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain",
    };
    if (token) {
      const headerName = config.authHeader?.trim() || "Authorization";
      const prefix = config.authPrefix ?? "Bearer ";
      headers[headerName] = `${prefix}${token}`;
    }

    let targetUrl = config.endpointUrl;
    let body: string | undefined;

    if (config.method === "GET") {
      const urlObj = new URL(config.endpointUrl);
      const queryParam = config.queryParamName?.trim() || "q";
      if (typeof args.query === "string" && args.query.trim()) {
        urlObj.searchParams.set(queryParam, args.query.trim());
      } else {
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined && v !== null) {
            urlObj.searchParams.set(k, String(v));
          }
        }
      }
      targetUrl = urlObj.toString();
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(args);
    }

    const res = await fetchFn(targetUrl, {
      method: config.method,
      headers,
      body,
      signal: controller.signal,
    });

    const rawText = await res.text();
    const truncated = truncateUtf8(rawText, maxBytes);

    if (!res.ok) {
      const infra = isInfraHttpStatus(res.status);
      return {
        ok: false,
        infrastructureFailure: infra,
        content: JSON.stringify({
          error: `HTTP ${res.status}`,
          detail: truncated.slice(0, 400),
        }),
        error: `HTTP ${res.status}: ${truncated.slice(0, 200)}`,
      };
    }

    return {
      ok: true,
      infrastructureFailure: false,
      content: truncated,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort
      ? `HTTP 工具请求超时（>${timeoutMs}ms）`
      : `HTTP 工具网络异常: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ok: false,
      infrastructureFailure: true,
      content: JSON.stringify({ error: msg }),
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpApiRegisteredTool(
  plugin: Stage2ToolRecord,
  token: string | null,
  fetchImpl?: typeof fetch,
): RegisteredTool {
  const config = plugin.config as unknown as HttpApiToolConfig;
  const queryParam = config.queryParamName?.trim() || "q";

  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    functionName: config.functionName,
    definition: {
      type: "function",
      function: {
        name: config.functionName,
        description: `[${plugin.name}] ${config.description}`,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: `查询关键词或商品标识（将作为 ${config.method === "GET" ? `参数 ${queryParam}` : "JSON 字段"} 发送）`,
            },
          },
          required: ["query"],
        },
      },
    },
    execute: (args) => callHttpApiTool(config, token, args, fetchImpl),
  };
}
