import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { getJevProxyUrl } from "@/lib/env";
import { callSystemOne } from "@/lib/jev/client";

afterEach(() => vi.unstubAllEnvs());

it("代理配置非法时拒绝请求，不回落到直连", () => {
  expect(() => getJevProxyUrl({ JEV_PROXY_URL: "socks5://localhost:1080" })).toThrow();
  expect(() => getJevProxyUrl({ JEV_PROXY_URL: "http://user:secret@localhost" })).toThrow();
  expect(getJevProxyUrl({})).toBeUndefined();
});

it.each([
  { size: "小请求", state: "{}", paced: false },
  { size: "大请求", state: "x".repeat(38_500) + "测试", paced: true },
])("真实 CONNECT 代理转发$size，不解析或直连目标域名", async ({ state, paced }) => {
  const server = createServer();
  let destination = "";
  let payload = "";
  server.on("connect", (req, socket) => {
    destination = req.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const separator = received.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const headers = received.subarray(0, separator).toString();
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1]);
      if (!Number.isFinite(length) || received.length - separator - 4 < length) return;
      payload = received.toString();
      const response = JSON.stringify({ answers: { q1: { type: "choice", choice: "matched" } } });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(response)}\r\nConnection: close\r\n\r\n${response}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv("JEV_PROXY_URL", `http://127.0.0.1:${port}`);
  try {
    const result = await callSystemOne(
      { baseUrl: "http://jev-proxy-test.invalid", apiKey: "test-key", model: "jev-latest", timeoutMs: 3000 },
      { state, model: "jev-latest", questions: {} },
    );
    expect(destination).toBe("jev-proxy-test.invalid:80");
    expect(payload).toContain("POST /v1/systemone");
    expect(payload).toContain(JSON.stringify({ state, model: "jev-latest", questions: {} }));
    if (paced) expect(payload).toMatch(/\r\nconnection: close\r\n/i);
    expect(result.answers?.q1).toBeDefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
