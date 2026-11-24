import { createHash } from "node:crypto";
import type {
  CachedMcpToolSchema,
  McpToolConfig,
  Stage2ToolRecord,
} from "@/lib/domain/types";
import type { RegisteredTool, ToolExecutionOutcome } from "@/lib/agent/tools/types";

const DEFAULT_MCP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 12_288;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export function buildMcpFunctionName(toolId: string, remoteName: string): string {
  const hash = createHash("sha256").update(toolId).digest("hex").slice(0, 6);
  const safeRemote = remoteName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";
  const prefix = `mcp_${hash}_`;
  const maxRemoteLen = Math.max(1, 64 - prefix.length);
  return `${prefix}${safeRemote.slice(0, maxRemoteLen)}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return `${sliced}\n...[已截断，原始长度 ${buf.byteLength} 字节]`;
}

function parseSseOrJsonRpc(
  contentType: string,
  bodyText: string,
): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    const lines = bodyText.split(/\r?\n/);
    let lastPayload: JsonRpcResponse | null = null;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(dataStr) as JsonRpcResponse;
        if (parsed && typeof parsed === "object") {
          lastPayload = parsed;
        }
      } catch {
        // 跳过非 JSON 心跳行
      }
    }
    if (!lastPayload) {
      throw new Error("MCP SSE 响应未包含有效的 JSON-RPC payload");
    }
    return lastPayload;
  }

  return JSON.parse(bodyText) as JsonRpcResponse;
}

function buildAuthHeaders(
  config: McpToolConfig,
  token: string | null,
  sessionId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) {
    const headerName = config.authHeader?.trim() || "Authorization";
    const prefix = config.authPrefix ?? "Bearer ";
    headers[headerName] = `${prefix}${token}`;
  }
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  return headers;
}

function isInfraHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

async function sendMcpJsonRpc(
  config: McpToolConfig,
  token: string | null,
  method: string,
  params: Record<string, unknown>,
  options: {
    id: string | number;
    sessionId?: string | null;
    fetchImpl?: typeof fetch;
  },
): Promise<{
  ok: boolean;
  infrastructureFailure: boolean;
  result?: unknown;
  sessionId?: string | null;
  error?: string;
}> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(config.endpointUrl, {
      method: "POST",
      headers: buildAuthHeaders(config, token, options.sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: options.id,
        method,
        params,
      }),
      signal: controller.signal,
    });

    const nextSessionId = res.headers.get("mcp-session-id") ?? options.sessionId ?? null;
    const rawText = await res.text();

    if (!res.ok) {
      const infra = isInfraHttpStatus(res.status);
      return {
        ok: false,
        infrastructureFailure: infra,
        sessionId: nextSessionId,
        error: `MCP HTTP ${res.status}: ${rawText.slice(0, 200)}`,
      };
    }

    let parsed: JsonRpcResponse;
    try {
      const ct = res.headers.get("content-type") ?? "";
      parsed = parseSseOrJsonRpc(ct, rawText);
    } catch (err) {
      return {
        ok: false,
        infrastructureFailure: true,
        sessionId: nextSessionId,
        error: `MCP 协议解析失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (parsed.error) {
      return {
        ok: false,
        infrastructureFailure: false,
        sessionId: nextSessionId,
        error: parsed.error.message ?? `MCP JSON-RPC error ${parsed.error.code ?? ""}`,
      };
    }

    return {
      ok: true,
      infrastructureFailure: false,
      result: parsed.result,
      sessionId: nextSessionId,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      infrastructureFailure: true,
      error: isAbort
        ? `MCP 请求超时（>${timeoutMs}ms）`
        : `MCP 网络异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverMcpTools(
  config: McpToolConfig,
  token: string | null,
  fetchImpl?: typeof fetch,
): Promise<
  | { ok: true; tools: CachedMcpToolSchema[] }
  | { ok: false; error: string }
> {
  const initRes = await sendMcpJsonRpc(
    config,
    token,
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "11jev-stage2", version: "1.0.0" },
    },
    { id: 1, fetchImpl },
  );

  if (!initRes.ok) {
    return { ok: false, error: initRes.error ?? "MCP initialize 失败" };
  }

  const listRes = await sendMcpJsonRpc(
    config,
    token,
    "tools/list",
    {},
    { id: 2, sessionId: initRes.sessionId, fetchImpl },
  );

  if (!listRes.ok) {
    return { ok: false, error: listRes.error ?? "MCP tools/list 失败" };
  }

  const rawTools = (listRes.result as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(rawTools)) {
    return { ok: false, error: "MCP tools/list 返回格式缺少 tools 数组" };
  }

  const tools: CachedMcpToolSchema[] = rawTools
    .filter(
      (t): t is Record<string, unknown> =>
        Boolean(t) && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
    )
    .map((t) => ({
      name: String(t.name),
      description:
        typeof t.description === "string" && t.description.trim()
          ? t.description.trim()
          : `MCP 工具 ${String(t.name)}`,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    }));

  return { ok: true, tools };
}

export async function callMcpRemoteTool(
  config: McpToolConfig,
  token: string | null,
  remoteToolName: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<ToolExecutionOutcome> {
  const res = await sendMcpJsonRpc(
    config,
    token,
    "tools/call",
    { name: remoteToolName, arguments: args },
    { id: `call-${Date.now()}`, fetchImpl },
  );

  if (!res.ok) {
    const errMsg = res.error ?? "MCP 工具调用失败";
    return {
      ok: false,
      infrastructureFailure: res.infrastructureFailure,
      content: JSON.stringify({ error: errMsg }),
      error: errMsg,
    };
  }

  const resultObj = res.result as
    | { content?: unknown; isError?: boolean }
    | undefined;
  const textContent = Array.isArray(resultObj?.content)
    ? resultObj.content
        .map((c) => {
          if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
            return c.text;
          }
          return JSON.stringify(c);
        })
        .join("\n")
    : JSON.stringify(res.result ?? {});

  const truncated = truncateUtf8(textContent, DEFAULT_MAX_RESPONSE_BYTES);
  if (resultObj?.isError === true) {
    return {
      ok: false,
      infrastructureFailure: false,
      content: truncated,
      error: truncated.slice(0, 300),
    };
  }

  return {
    ok: true,
    infrastructureFailure: false,
    content: truncated,
  };
}

export function createMcpRegisteredTools(
  plugin: Stage2ToolRecord,
  token: string | null,
  fetchImpl?: typeof fetch,
): RegisteredTool[] {
  const config = plugin.config as unknown as McpToolConfig;
  const cached = plugin.cachedSchema ?? [];
  if (cached.length === 0) return [];

  const allowSet =
    Array.isArray(config.allowedTools) && config.allowedTools.length > 0
      ? new Set(config.allowedTools)
      : null;

  return cached
    .filter((schema) => !allowSet || allowSet.has(schema.name))
    .map((schema) => {
      const fnName = buildMcpFunctionName(plugin.id, schema.name);
      return {
        pluginId: plugin.id,
        pluginName: plugin.name,
        functionName: fnName,
        definition: {
          type: "function",
          function: {
            name: fnName,
            description: `[${plugin.name}] ${schema.description}`,
            parameters: schema.inputSchema,
          },
        },
        execute: (args) =>
          callMcpRemoteTool(config, token, schema.name, args, fetchImpl),
      };
    });
}
