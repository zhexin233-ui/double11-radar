import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { getJevProxyUrl } from "@/lib/env";

// 部署配置在进程生命周期内固定；每个进程复用连接池，不修改全局 dispatcher。
let proxy: { url: string; agent: Dispatcher } | undefined;

export function fetchJev(url: string, init: RequestInit): Promise<Response> {
  const proxyUrl = getJevProxyUrl();
  if (!proxyUrl) return fetch(url, init);
  if (proxy?.url !== proxyUrl) {
    if (proxy) void proxy.agent.close();
    const agent = proxyUrl.startsWith("socks5:")
      ? new Socks5ProxyAgent(proxyUrl)
      : new ProxyAgent(proxyUrl);
    proxy = { url: proxyUrl, agent };
  }
  const options: RequestInit & { dispatcher: Dispatcher } = {
    ...init,
    dispatcher: proxy.agent,
  };
  return fetch(url, options);
}
