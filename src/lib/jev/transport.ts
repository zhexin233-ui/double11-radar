import { setTimeout as delay } from "node:timers/promises";
import { ProxyAgent } from "undici";
import { getJevProxyUrl } from "@/lib/env";

// 部署配置在进程生命周期内固定；每个进程复用连接池，不修改全局 dispatcher。
let proxy: { url: string; agent: ProxyAgent; pacedAgent?: ProxyAgent } | undefined;

const PACED_BODY_THRESHOLD = 4 * 1024;
const BODY_CHUNK_BYTES = 1024;
const MAX_CHUNK_DELAY_MS = 35;
const MAX_UPLOAD_DELAY_MS = 1500;

function pacedBody(bytes: Buffer, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const chunkCount = Math.ceil(bytes.length / BODY_CHUNK_BYTES);
  const chunkDelay = Math.min(MAX_CHUNK_DELAY_MS, Math.floor(MAX_UPLOAD_DELAY_MS / chunkCount));
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > 0 && chunkDelay > 0) {
        await delay(chunkDelay, undefined, { signal });
      }
      const chunk = bytes.subarray(offset, offset + BODY_CHUNK_BYTES);
      offset += chunk.length;
      controller.enqueue(chunk);
      if (offset === bytes.length) controller.close();
    },
  }, { highWaterMark: 0 });
}

export function fetchJev(url: string, init: RequestInit): Promise<Response> {
  const proxyUrl = getJevProxyUrl();
  if (!proxyUrl) return fetch(url, init);
  if (proxy?.url !== proxyUrl) {
    if (proxy) {
      void proxy.agent.close();
      void proxy.pacedAgent?.close();
    }
    proxy = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
  }
  const options: RequestInit & { dispatcher: ProxyAgent; duplex?: "half" } = {
    ...init, dispatcher: proxy.agent,
  };
  // 部分 CONNECT 出口会重置突发发送的明文 HTTP 大包。分段写入并保留内容长度。
  if (url.startsWith("http://") && typeof init.body === "string" &&
      Buffer.byteLength(init.body) >= PACED_BODY_THRESHOLD) {
    const bytes = Buffer.from(init.body);
    const headers = new Headers(init.headers);
    headers.set("content-length", String(bytes.length));
    proxy.pacedAgent ??= new ProxyAgent({ uri: proxyUrl, pipelining: 0 });
    options.dispatcher = proxy.pacedAgent;
    options.headers = headers;
    options.body = pacedBody(bytes, init.signal ?? undefined);
    options.duplex = "half";
  }
  return fetch(url, options);
}
