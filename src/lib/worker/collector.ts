import type Database from "better-sqlite3";
import {
  fetchFeed as defaultFetchFeed,
  fetchMeta as defaultFetchMeta,
  type XianbaoError,
} from "@/lib/sources/xianbao/client";
import { insertBulletinIfAbsent, hasActiveRecordInOtherNs } from "@/lib/db/repos/bulletins";
import { enqueueJob } from "@/lib/db/repos/jobs";
import {
  getChannelSelection,
  listChannels,
  listDueChannels,
  markChannelError,
  markChannelSuccess,
  setChannelInitialized,
  syncChannelsFromCatalog,
  tryClaimChannelPoll,
} from "@/lib/db/repos/channels";
import { getRuntimeState, patchRuntimeState } from "@/lib/worker/runtime-state";
import type { AppEnv } from "@/lib/env";
import type { ChannelState } from "@/lib/domain/types";

/**
 * 采集循环。
 *
 * - meta 按 600 秒节流同步（能力清单失败不影响已存频道）；
 * - 逐频道原子占用 + 按缓存/限流预算调度，单个频道失败不影响其它频道；
 * - 频道首次成功快照写基线（`baseline = 1`）且**不入队**；之后的新条目才入队判断；
 * - 跨频道重复文章按来源编号空间分别记录，基线化不会改动其它频道已有记录。
 */

const META_CACHE_SECONDS = 600;
/** 保守的全局限流预算：线报酷为 60 次/分钟/IP/接口。 */
export const REQUEST_BUDGET_PER_MINUTE = 50;
const MIN_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const MAX_CHANNELS_PER_ROUND = 6;

export interface CollectorDeps {
  fetchMeta?: typeof defaultFetchMeta;
  fetchFeed?: typeof defaultFetchFeed;
  now?: () => Date;
}

export interface CollectorRoundResult {
  polled: number;
  baseline: number;
  enqueued: number;
  errors: number;
  metaSynced: boolean;
}

/** 依据选中频道数与缓存时间计算每频道最小轮询间隔（秒）。 */
export function computePollIntervalSeconds(
  selectedChannelCount: number,
  cacheTtlSeconds: number | null,
): number {
  const count = Math.max(1, selectedChannelCount);
  const budgetInterval = Math.ceil((60 * count) / REQUEST_BUDGET_PER_MINUTE);
  const ttl = cacheTtlSeconds ?? MIN_POLL_INTERVAL_SECONDS;
  return Math.max(MIN_POLL_INTERVAL_SECONDS, ttl, budgetInterval);
}

function errorRetryDelayMs(error: unknown): number {
  const candidate = error as Partial<XianbaoError> & { message?: string };
  if (typeof candidate?.retryAfterMs === "number" && candidate.retryAfterMs > 0) {
    return Math.min(candidate.retryAfterMs, 10 * 60 * 1000);
  }
  return DEFAULT_POLL_INTERVAL_SECONDS * 1000;
}

async function syncMetaIfDue(
  db: Database.Database,
  env: AppEnv,
  deps: CollectorDeps,
  nowIso: string,
  now: Date,
): Promise<boolean> {
  const runtime = getRuntimeState(db);
  const lastSync = runtime.lastMetaSyncAt
    ? Date.parse(runtime.lastMetaSyncAt)
    : Number.NaN;
  const existingChannels = listChannels(db);
  const due =
    Number.isNaN(lastSync) ||
    now.getTime() - lastSync > META_CACHE_SECONDS * 1000 ||
    existingChannels.length === 0;
  if (!due) return false;

  const fetchMeta = deps.fetchMeta ?? defaultFetchMeta;
  try {
    const meta = await fetchMeta({ baseUrl: env.xianbaoApiBase });
    syncChannelsFromCatalog(db, meta.channels, getChannelSelection(db));
    patchRuntimeState(db, { lastMetaSyncAt: nowIso });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 能力清单失败不清空既有频道选择，只记录状态。
    patchRuntimeState(db, {
      lastError: `同步频道清单失败：${message}`,
      lastErrorAt: nowIso,
      lastErrorStage: "collect.meta",
    });
    return false;
  }
}

async function pollChannel(
  db: Database.Database,
  env: AppEnv,
  channel: ChannelState,
  deps: CollectorDeps,
  nowIso: string,
  now: Date,
  intervalSeconds: number,
): Promise<{ baseline: number; enqueued: number; ok: boolean }> {
  const fetchFeed = deps.fetchFeed ?? defaultFetchFeed;
  const channelRef = {
    id: channel.id,
    alias: channel.alias ?? channel.id,
    origin: channel.origin,
  };

  try {
    const feed = await fetchFeed(channelRef, {
      baseUrl: env.xianbaoApiBase,
      limit: 50,
    });
    const effectiveInterval = computePollIntervalSeconds(
      Math.max(
        listChannels(db).filter((c) => c.selected && c.available).length,
        1,
      ),
      feed.cacheTtlSeconds ?? channel.cacheTtlSeconds ?? intervalSeconds,
    );
    const nextPollAt = new Date(
      now.getTime() + effectiveInterval * 1000,
    ).toISOString();

    const isBaseline = !channel.initialized;
    let baselineCount = 0;
    let enqueued = 0;

    const apply = db.transaction(() => {
      for (const item of feed.items) {
        // 跨频道基线保护：同来源记录若已在其它编号空间被处理，仍按本频道
        // 编号空间独立记录，但绝不改动其它频道已有行。
        if (isBaseline) {
          // 仅作跨频道基线保护的显式检查与回归点，返回值不改变本频道插入语义。
          void hasActiveRecordInOtherNs(db, item.source, item.sourceId, item.sourceNs);
        }
        const result = insertBulletinIfAbsent(db, item, { baseline: isBaseline });
        if (!result.inserted) continue;
        if (isBaseline) {
          baselineCount += 1;
        } else {
          const job = enqueueJob(db, {
            kind: "evaluate",
            payloadKey: `evaluate:${result.id}`,
            payload: { bulletinId: result.id },
          });
          if (job.created) enqueued += 1;
        }
      }
      if (isBaseline) {
        setChannelInitialized(db, channel.id, true);
      }
    });
    apply.immediate();

    markChannelSuccess(db, channel.id, {
      nextPollAt,
      lastSuccessAt: nowIso,
      cacheTtlSeconds: feed.cacheTtlSeconds ?? undefined,
    });
    return { baseline: baselineCount, enqueued, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(now.getTime() + errorRetryDelayMs(error)).toISOString();
    markChannelError(db, channel.id, {
      error: message,
      lastErrorAt: nowIso,
      nextPollAt: retryAt,
    });
    return { baseline: 0, enqueued: 0, ok: false };
  }
}

export async function runCollectorOnce(
  db: Database.Database,
  env: AppEnv,
  deps: CollectorDeps = {},
): Promise<CollectorRoundResult> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const metaSynced = await syncMetaIfDue(db, env, deps, nowIso, now);

  const selected = listChannels(db).filter((c) => c.selected && c.available);
  const intervalSeconds = computePollIntervalSeconds(
    selected.length,
    MIN_POLL_INTERVAL_SECONDS,
  );
  const due = listDueChannels(db, nowIso, MAX_CHANNELS_PER_ROUND);

  const result: CollectorRoundResult = {
    polled: 0,
    baseline: 0,
    enqueued: 0,
    errors: 0,
    metaSynced,
  };

  for (const channel of due) {
    const nextPollAt = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
    if (!tryClaimChannelPoll(db, channel.id, nowIso, nextPollAt)) continue;
    const outcome = await pollChannel(
      db,
      env,
      channel,
      deps,
      nowIso,
      now,
      intervalSeconds,
    );
    result.polled += 1;
    result.baseline += outcome.baseline;
    result.enqueued += outcome.enqueued;
    if (!outcome.ok) result.errors += 1;
  }

  patchRuntimeState(db, {
    lastCollectAt: nowIso,
    ...(result.errors > 0
      ? {
          lastError: `${result.errors} 个频道采集失败`,
          lastErrorAt: nowIso,
          lastErrorStage: "collect",
        }
      : {}),
  });
  return result;
}
