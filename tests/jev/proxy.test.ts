import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { getJevProxyUrl } from "@/lib/env";
import { callSystemOne } from "@/lib/jev/client";

afterEach(() => vi.unstubAllEnvs());

it("代理配置非法时拒绝请求，不回落到直连", () => {
  expect(() => getJevProxyUrl({ JEV_PROXY_URL: "socks4://localhost:1080" })).toThrow();
  expect(() => getJevProxyUrl({ JEV_PROXY_URL: "socks5:localhost:1080" })).toThrow();
  expect(() => getJevProxyUrl({ JEV_PROXY_URL: "http://user:secret@localhost" })).toThrow();
  expect(getJevProxyUrl({})).toBeUndefined();
});

function replyToSystemOne(socket: Duplex, observe: (payload: string) => void) {
  let payload = "";
  socket.on("data", (chunk: Buffer) => {
    payload += chunk.toString();
    const separator = payload.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const body = payload.slice(separator + 4);
    const length = Number(/content-length: (\d+)/i.exec(payload.slice(0, separator))?.[1]);
    if (!Number.isFinite(length) || Buffer.byteLength(body) < length) return;
    observe(payload);
    const response = JSON.stringify({ answers: { q1: { type: "choice", choice: "matched" } } });
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(response)}\r\nConnection: close\r\n\r\n${response}`);
  });
}

it("真实 CONNECT 传输经过本地测试代理，不解析或直连目标域名", async () => {
  const server = createServer();
  let destination = "";
  let payload = "";
  server.on("connect", (req, socket) => {
    destination = req.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    replyToSystemOne(socket, (request) => { payload = request; });
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

it("SOCKS5 通过代理发送完整的大请求并解析判断响应", async () => {
  let destination = "";
  let payload = "";
  const server = createTcpServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", (request) => {
        destination = request.subarray(5, 5 + request[4]).toString();
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        replyToSystemOne(socket, (input) => { payload = input; });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv("JEV_PROXY_URL", `socks5://127.0.0.1:${port}`);
  const state = "x".repeat(38_500);
  try {
    const result = await callSystemOne(
      { baseUrl: "http://jev-proxy-test.invalid", apiKey: "fixture-credential", model: "d1.1", timeoutMs: 3000 },
      { state, model: "d1.1", questions: {} },
    );
    expect(destination).toBe("jev-proxy-test.invalid");
    expect(payload).toContain(`"state":"${state}"`);
    expect(result.answers?.q1).toBeDefined();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
