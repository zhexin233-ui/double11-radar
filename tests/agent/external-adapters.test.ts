import { describe, expect, it } from "vitest";
import {
  buildMcpFunctionName,
  callMcpRemoteTool,
  discoverMcpTools,
} from "@/lib/agent/tools/mcp-adapter";
import { callHttpApiTool } from "@/lib/agent/tools/http-adapter";

describe("agent/external-adapters (AC5)", () => {
  it("MCP 支持 Streamable HTTP / SSE 的 initialize、tools/list 与 tools/call", async () => {
    const sseMockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: unknown;
        method: string;
      };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2024-11-05" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-1",
            },
          },
        );
      }
      if (body.method === "tools/list") {
        const sse = `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "price_lookup",
                description: "查询外部历史价",
                inputSchema: {
                  type: "object",
                  properties: { keyword: { type: "string" } },
                },
              },
            ],
          },
        })}\n\n`;
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "最低价 25.9 元" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const discovered = await discoverMcpTools(
      { endpointUrl: "https://mcp.example.com/mcp" },
      "tok-123",
      sseMockFetch,
    );
    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(discovered.tools).toHaveLength(1);
      expect(discovered.tools[0].name).toBe("price_lookup");
    }

    const callRes = await callMcpRemoteTool(
      { endpointUrl: "https://mcp.example.com/mcp" },
      "tok-123",
      "price_lookup",
      { keyword: "抽纸" },
      sseMockFetch,
    );
    expect(callRes.ok).toBe(true);
    expect(callRes.content).toContain("25.9");

    const fnName = buildMcpFunctionName("tool-1", "price/lookup@v1");
    expect(fnName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("HTTP API 支持 GET/POST、鉴权头、响应截断与 5xx 分类", async () => {
    let capturedAuth: string | null = null;
    const hugeBody = "A".repeat(2000);
    const res = await callHttpApiTool(
      {
        functionName: "q_price",
        description: "desc",
        endpointUrl: "https://api.example.com/price",
        method: "GET",
        queryParamName: "kw",
        maxResponseBytes: 512,
      },
      "secret-token",
      { query: "维达" },
      async (url, init) => {
        capturedAuth = new Headers(init?.headers).get("Authorization");
        expect(String(url)).toContain("kw=%E7%BB%B4%E8%BE%BE");
        return new Response(hugeBody, { status: 200 });
      },
    );
    expect(capturedAuth).toBe("Bearer secret-token");
    expect(res.ok).toBe(true);
    expect(res.content).toContain("已截断");

    const errRes = await callHttpApiTool(
      {
        functionName: "q_price",
        description: "desc",
        endpointUrl: "https://api.example.com/price",
        method: "POST",
      },
      null,
      { query: "维达" },
      async () => new Response("rate limited", { status: 429 }),
    );
    expect(errRes.ok).toBe(false);
    expect(errRes.infrastructureFailure).toBe(true);
  });
});
