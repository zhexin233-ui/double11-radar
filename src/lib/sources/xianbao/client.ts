import { EnvelopeSchema, MetaDataSchema } from "@/lib/sources/xianbao/types";
import type { ChannelCatalogEntry } from "@/lib/sources/xianbao/types";
import {
  normalizeFeedItems,
  normalizeZdmItems,
  type NormalizeChannel,
} from "@/lib/sources/xianbao/normalize";
import type { NormalizedBulletin } from "@/lib/domain/types";

/**
 * 线报酷公开 API 客户端。
 *
 * - 必须先校验外层 `code === 0`，非 0 视为业务失败；
 * - 429 读取 `Retry-After`（秒或 HTTP-date）与 `X-RateLimit-Reset`；
 * - 轮询间隔使用响应 `meta.cache_ttl`（实测 10 秒）作为下限。
 */

export const DEFAULT_XIANBAO_BASE = "https://new.xianbao.fun";

/**
 * 不在分类流中轮询的别名：
 * - `zhidemai` 分类流与 `type=zdm` 独立流覆盖同一内容；
 * - `zdm` 本身就是独立数据源，统一由附加的 zdm 频道（origin=zdm）处理。
 */
export const EXCLUDED_FEED_ALIASES = ["zhidemai", "zdm"] as const;

/** 值得买独立流作为附加频道。 */
export const ZDM_CHANNEL: ChannelCatalogEntry = {
  id: "zdm",
  name: "值得买（独立流）",
  alias: "zdm",
  origin: "zdm",
};

export class XianbaoError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: { status?: number; code?: string | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "XianbaoError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface XianbaoClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 站点返回的限流信息（实测响应头 `X-RateLimit-*`）。 */
export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** 窗口重置时间（UTC ISO8601），由 `X-RateLimit-Reset`（Unix 秒）换算。 */
  resetAt: string | null;
}

function parseNumericHeader(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readRateLimit(headers: Headers): RateLimitInfo {
  const resetSeconds = parseNumericHeader(headers.get("x-ratelimit-reset"));
  return {
    limit: parseNumericHeader(headers.get("x-ratelimit-limit")),
    remaining: parseNumericHeader(headers.get("x-ratelimit-remaining")),
    resetAt:
      resetSeconds !== null && resetSeconds > 0
        ? new Date(resetSeconds * 1000).toISOString()
        : null,
  };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function combineSignals(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return { signal: timeout, cleanup: () => undefined };
  return {
    signal: AbortSignal.any([timeout, external]),
    cleanup: () => undefined,
  };
}

async function request(
  url: string,
  options: XianbaoClientOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const { signal } = combineSignals(timeoutMs, options.signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new XianbaoError(`请求线报酷失败：${message}`, { status: 0 });
  }

  if (response.status === 429) {
    throw new XianbaoError("线报酷接口限流（429）", {
      status: 429,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) ?? 60000,
    });
  }
  if (!response.ok) {
    throw new XianbaoError(`线报酷接口返回 HTTP ${response.status}`, {
      status: response.status,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new XianbaoError(`线报酷响应不是合法 JSON：${message}`, {
      status: response.status,
    });
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new XianbaoError("线报酷响应结构不符合预期", {
      status: response.status,
    });
  }
  if (envelope.data.code !== 0) {
    throw new XianbaoError(
      `线报酷业务失败（code=${envelope.data.code}${envelope.data.msg ? `：${envelope.data.msg}` : ""}）`,
      { status: response.status, code: String(envelope.data.code) },
    );
  }
  return { data: envelope.data.data, meta: envelope.data.meta, rateLimit: readRateLimit(response.headers) };
}

export interface MetaResult {
  channels: ChannelCatalogEntry[];
  cacheTtlSeconds: number | null;
  rateLimit: { limit: number | null; windowSeconds: number | null } | null;
}

/**
 * 拉取能力清单并归一化开放频道。
 * 跳过 `zhidemai` 分类流，附加 `zdm` 独立流，不使用 `all` 聚合流。
 */
export async function fetchMeta(
  options: XianbaoClientOptions = {},
): Promise<MetaResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_XIANBAO_BASE;
  const raw = (await request(`${baseUrl}/api/v1/meta`, options)) as {
    data: unknown;
    meta?: { cache_ttl?: number };
  };
  const parsed = MetaDataSchema.safeParse(raw.data);
  const channels: ChannelCatalogEntry[] = [];
  if (parsed.success) {
    for (const category of parsed.data.abilities?.feed?.categories ?? []) {
      if ((EXCLUDED_FEED_ALIASES as readonly string[]).includes(category.alias)) {
        continue;
      }
      channels.push({
        id: category.alias,
        name: category.name ?? category.alias,
        alias: category.alias,
        origin: "feed",
      });
    }
  }
  channels.push(ZDM_CHANNEL);

  const rateLimit = parsed.success
    ? {
        limit: parsed.data.rate_limit?.limit ?? null,
        windowSeconds: parsed.data.rate_limit?.window_seconds ?? null,
      }
    : null;

  return {
    channels,
    cacheTtlSeconds: raw.meta?.cache_ttl ?? null,
    rateLimit,
  };
}

export interface FeedResult {
  items: NormalizedBulletin[];
  cacheTtlSeconds: number | null;
  rateLimit: RateLimitInfo | null;
}

/** 拉取单个频道的最新快照（不做分页或历史补齐）。 */
export async function fetchFeed(
  channel: NormalizeChannel,
  options: XianbaoClientOptions & { limit?: number } = {},
): Promise<FeedResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_XIANBAO_BASE;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
  const params = new URLSearchParams();
  if (channel.origin === "zdm") {
    params.set("type", "zdm");
  } else {
    params.set("cate", channel.alias ?? channel.id);
  }
  params.set("limit", String(limit));

  const raw = (await request(
    `${baseUrl}/api/v1/feed?${params.toString()}`,
    options,
  )) as {
    data: unknown;
    meta?: { cache_ttl?: number };
    rateLimit: RateLimitInfo | null;
  };

  const items =
    channel.origin === "zdm"
      ? normalizeZdmItems(raw.data)
      : normalizeFeedItems(raw.data, channel);

  return {
    items,
    cacheTtlSeconds: raw.meta?.cache_ttl ?? null,
    rateLimit: raw.rateLimit ?? null,
  };
}
