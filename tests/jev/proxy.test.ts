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

it("真实 CONNECT 传输经过本地测试代理，不解析或直连目标域名", async () => {
  const server = createServer();
  let destination = "";
  let payload = "";
  server.on("connect", (req, socket) => {
    destination = req.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", (chunk) => {
      payload += chunk.toString();
      const [headers, body = ""] = payload.split("\r\n\r\n");
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
      if (Buffer.byteLength(body) < length) return;
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
      { state: "{}", model: "jev-latest", questions: {} },
    );
    expect(destination).toBe("jev-proxy-test.invalid:80");
    expect(payload).toContain("POST /v1/systemone");
    expect(result.answers?.q1).toBeDefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
