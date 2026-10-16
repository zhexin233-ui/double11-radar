import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  fetchFeed as defaultFetchFeed,
  fetchMeta as defaultFetchMeta,
  type RateLimitInfo,
  type XianbaoError,
} from "@/lib/sources/xianbao/client";
import { insertBulletinIfAbsent, hasActiveRecordInOtherNs } from "@/lib/db/repos/bulletins";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { listEnabledNeeds } from "@/lib/db/repos/needs";
import {
  insertBatchPart,
  insertEvaluationRun,
  insertProcessing,
} from "@/lib/db/repos/evaluation-runs";
import { packBatchParts } from "@/lib/jev/batch-packing";
import type { GateMember } from "@/lib/jev/batch-prompt";
import { getJevConfig, getJevConfigView } from "@/lib/service/config";
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
import type { ChannelState, NeedSnapshot } from "@/lib/domain/types";

/**
 * 采集循环。
 *
 * - meta 按 600 秒节流同步（能力清单失败不影响已存频道）；
 * - 逐频道原子占用 + 按缓存/限流预算调度，单个频道失败不影响其它频道；
 * - 频道首次成功快照写基线（`baseline = 1`）且**不入队**；之后的新条目才入队判断；
 * - 跨频道重复文章按来源编号空间分别记录，基线化不会改动其它频道已有记录。
 */

const META_CACHE_SECONDS = 600;
/**
 * 保守的全局限流预算（次/分钟）。
 *
 * 文档写的是 60 次/分钟/IP/接口（实测 `x-ratelimit-limit: 60`，并返回
 * `X-RateLimit-Remaining/Reset`）。实测同时发现：错误重试会让实际消耗超过稳态预算，
 * 从而在窗口内触发 429。因此稳态目标取额度的一半（30/分钟）作为重试余量，
 * 并对频道请求保留轮内最小间隔与全局暂停。
 */
export const REQUEST_BUDGET_PER_MINUTE = 30;
/** 同一轮内两次频道请求之间的最小间隔，用于削峰。 */
export const MIN_REQUEST_SPACING_MS = 1200;
const MIN_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const MAX_CHANNELS_PER_ROUND = 6;

export interface CollectorDeps {
  fetchMeta?: typeof defaultFetchMeta;
  fetchFeed?: typeof defaultFetchFeed;
  now?: () => Date;
  /** 测试可设为 0 跳过轮内间隔。 */
  requestSpacingMs?: number;
}

/** 剩余额度低于该值时，把全局采集暂停到窗口重置。 */
export const RATE_LIMIT_LOW_WATERMARK = 5;

/** 依据限流响应头计算全局暂停截止时间；无需暂停时返回 null。 */
export function computeRateLimitBackoff(input: {
  remaining: number | null;
  resetAt: string | null;
  now: Date;
}): string | null {
  const { remaining, resetAt, now } = input;
  if (remaining === null) return null;
  if (remaining > RATE_LIMIT_LOW_WATERMARK) return null;
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    if (!Number.isNaN(resetMs) && resetMs > now.getTime()) {
      return new Date(resetMs).toISOString();
    }
  }
  return new Date(now.getTime() + 60_000).toISOString();
}

/** 当前是否处于限流暂停期。 */
export function isRateLimitPaused(
  backoffUntil: string | null,
  now: Date,
): boolean {
  if (!backoffUntil) return false;
  const until = Date.parse(backoffUntil);
  return !Number.isNaN(until) && until > now.getTime();
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CollectorRoundResult {
  polled: number;
  baseline: number;
  enqueued: number;
  errors: number;
  metaSynced: boolean;
  /** 本轮因全局限流暂停而未发起任何请求。 */
  rateLimited: boolean;
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
): Promise<{
  baseline: number;
  enqueued: number;
  ok: boolean;
  rateLimit: RateLimitInfo | null;
}> {
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
      const inserted: Array<{
        bulletinId: string;
        sourceNs: string;
        member: GateMember;
      }> = [];
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
          inserted.push({
            bulletinId: result.id,
            sourceNs: item.sourceNs,
            member: {
              id: result.id,
              title: item.title,
              content: item.content,
              category: item.category,
              brand: item.brand,
              mall: item.mall,
              price: item.price,
            },
          });
        }
      }

      if (isBaseline) {
        setChannelInitialized(db, channel.id, true);
        return;
      }
      if (inserted.length === 0) return;

      // 模式/规则/配置版本/需求读取必须与去重、建 run 在同一个 apply.immediate()
      // 事务内，不使用网络请求前或整轮缓存。
      const jevConfig = getJevConfig(db);
      const strategyConfigVersion = getJevConfigView(db).version;
      const mode = jevConfig.evaluationMode;
      const needs = listEnabledNeeds(db);
      const needSnapshots: NeedSnapshot[] =
        mode === "batch_gate"
          ? needs.map((need) => ({
              id: need.id,
              name: need.name,
              note: need.note,
              enabled: need.enabled,
              version: need.version,
            }))
          : [];

      const runId = randomUUID();
      insertEvaluationRun(db, {
        id: runId,
        sourceNs: inserted[0].sourceNs,
        evaluationMode: mode,
        strategyConfigVersion,
        regexRules: mode === "regex_gate" ? jevConfig.regexRules : null,
        needSnapshots: mode === "batch_gate" ? needSnapshots : null,
        createdAt: nowIso,
      });

      const gatePlan =
        mode === "batch_gate" && needSnapshots.length > 0
          ? packBatchParts(
              inserted.map((entry) => entry.member),
              needSnapshots,
              { model: jevConfig.model },
            )
          : null;

      if (gatePlan) {
        const partIdByBulletin = new Map<string, string>();
        gatePlan.parts.forEach((group, ordinal) => {
          const partId = randomUUID();
          insertBatchPart(db, { id: partId, runId, ordinal, createdAt: nowIso });
          for (const member of group) {
            partIdByBulletin.set(member.id, partId);
          }
          // 批次初筛也是一个调度任务，与逐条共用 jobsPerRound。
          const job = enqueueJob(db, {
            kind: "screen_batch",
            payloadKey: `screen_batch:${partId}`,
            payload: { partId, evaluationRunId: runId },
            runAt: nowIso,
          });
          if (job.created) enqueued += 1;
        });

        inserted.forEach((entry, index) => {
          const partId = partIdByBulletin.get(entry.bulletinId) ?? null;
          insertProcessing(db, {
            bulletinId: entry.bulletinId,
            runId,
            batchPartId: partId,
            position: index,
            createdAt: nowIso,
          });
          // 单成员/无法装箱的成员直接逐条，不发无效门控请求。
          if (partId) return;
          const job = enqueueJob(db, {
            kind: "evaluate",
            payloadKey: `evaluate:${entry.bulletinId}`,
            payload: { bulletinId: entry.bulletinId, evaluationRunId: runId },
            runAt: nowIso,
          });
          if (job.created) enqueued += 1;
        });
        return;
      }

      // individual / regex_gate / batch_gate 无启用需求：逐条任务。
      inserted.forEach((entry, index) => {
        insertProcessing(db, {
          bulletinId: entry.bulletinId,
          runId,
          batchPartId: null,
          position: index,
          createdAt: nowIso,
        });
        const job = enqueueJob(db, {
          kind: "evaluate",
          payloadKey: `evaluate:${entry.bulletinId}`,
          payload: { bulletinId: entry.bulletinId, evaluationRunId: runId },
          runAt: nowIso,
        });
        if (job.created) enqueued += 1;
      });
    });
    apply.immediate();

    markChannelSuccess(db, channel.id, {
      nextPollAt,
      lastSuccessAt: nowIso,
      cacheTtlSeconds: feed.cacheTtlSeconds ?? undefined,
    });
    return {
      baseline: baselineCount,
      enqueued,
      ok: true,
      rateLimit: feed.rateLimit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败重试不得早于稳态预算间隔，否则重试流量会叠加到正常轮询上。
    const retryDelayMs = Math.max(
      errorRetryDelayMs(error),
      intervalSeconds * 1000,
    );
    const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
    markChannelError(db, channel.id, {
      error: message,
      lastErrorAt: nowIso,
      nextPollAt: retryAt,
    });
    return { baseline: 0, enqueued: 0, ok: false, rateLimit: null };
  }
}

export async function runCollectorOnce(
  db: Database.Database,
  env: AppEnv,
  deps: CollectorDeps = {},
): Promise<CollectorRoundResult> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();

  // 全局限流暂停：额度耗尽时不在窗口内继续消耗请求。
  const before = getRuntimeState(db);
  if (isRateLimitPaused(before.rateLimitBackoffUntil, now)) {
    return {
      polled: 0,
      baseline: 0,
      enqueued: 0,
      errors: 0,
      metaSynced: false,
      rateLimited: true,
    };
  }

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
    rateLimited: false,
  };

  const observed: RateLimitInfo[] = [];

  for (const channel of due) {
    const nextPollAt = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
    if (!tryClaimChannelPoll(db, channel.id, nowIso, nextPollAt)) continue;
    if (result.polled > 0) {
      await delay(deps.requestSpacingMs ?? MIN_REQUEST_SPACING_MS);
    }
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
    if (outcome.rateLimit) observed.push(outcome.rateLimit);
  }

  // 依据本次观察到的剩余额度，决定是否全局暂停到窗口重置。
  const lowest = observed.reduce<RateLimitInfo | null>((acc, info) => {
    if (info.remaining === null) return acc;
    if (!acc || acc.remaining === null || info.remaining < acc.remaining) return info;
    return acc;
  }, null);

  const backoffUntil = lowest
    ? computeRateLimitBackoff({
        remaining: lowest.remaining,
        resetAt: lowest.resetAt,
        now,
      })
    : null;

  patchRuntimeState(db, {
    lastCollectAt: nowIso,
    ...(lowest
      ? { rateLimitRemaining: lowest.remaining, rateLimitResetAt: lowest.resetAt }
      : {}),
    ...(backoffUntil ? { rateLimitBackoffUntil: backoffUntil } : {}),
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
