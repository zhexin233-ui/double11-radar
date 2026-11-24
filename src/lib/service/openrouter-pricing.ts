import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getSetting, setSetting } from "@/lib/db/repos/settings";
import type {
  OpenRouterCatalogState,
  OpenRouterCatalogSyncStatus,
  OpenRouterModelPrice,
  Stage2LlmConfig,
  Stage2ResolvedRate,
} from "@/lib/domain/types";
import { describeNetworkFailure } from "@/lib/http/network-error";
import { fetchJev } from "@/lib/jev/transport";
import {
  decodeOpenRouterModelsPayload,
  resolveStage2Rates,
  type OpenRouterCatalogSnapshot,
} from "@/lib/stage2/pricing";

/**
 * OpenRouter 公开模型价格目录持久化与同步服务。
 *
 * - 使用独立 settings namespace（`stage2.openrouterCatalog`），不与 `stage2` 业务配置混存；
 * - 仅持久化精简后的 `{ id -> { inputUsdPerMillion, outputUsdPerMillion } }` 映射与同步状态；
 * - 复用项目代理传输层 `fetchJev`（支持 `JEV_PROXY_URL`）；
 * - HTTP 请求一律在 SQLite 事务外执行；
 * - 跨进程通过带到期时间的刷新占位（`refreshLockUntil`）避免重叠写入。
 */

export const OPENROUTER_CATALOG_NAMESPACE = "stage2.openrouterCatalog";
export const OPENROUTER_MODELS_API_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_REFRESH_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_REFRESH_FAILURE_TTL_MS = 60 * 60 * 1000;
export const OPENROUTER_REFRESH_LOCK_MS = 60 * 1000;
export const OPENROUTER_FETCH_TIMEOUT_MS = 15_000;

export const EMPTY_OPENROUTER_CATALOG_STATE: OpenRouterCatalogState = {
  models: {},
  modelCount: 0,
  snapshotVersion: null,
  status: "idle",
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  refreshLockUntil: null,
  refreshLockOwner: null,
};

function sanitizeModelsMap(raw: unknown): Record<string, OpenRouterModelPrice> {
  const out: Record<string, OpenRouterModelPrice> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !val || typeof val !== "object" || Array.isArray(val)) continue;
    const entry = val as {
      inputUsdPerMillion?: unknown;
      outputUsdPerMillion?: unknown;
    };
    const inputUsdPerMillion =
      typeof entry.inputUsdPerMillion === "number" &&
      Number.isFinite(entry.inputUsdPerMillion) &&
      entry.inputUsdPerMillion >= 0
        ? entry.inputUsdPerMillion
        : null;
    const outputUsdPerMillion =
      typeof entry.outputUsdPerMillion === "number" &&
      Number.isFinite(entry.outputUsdPerMillion) &&
      entry.outputUsdPerMillion >= 0
        ? entry.outputUsdPerMillion
        : null;
    out[key] = { inputUsdPerMillion, outputUsdPerMillion };
  }
  return out;
}

export function getOpenRouterCatalogState(
  db: Database.Database,
): OpenRouterCatalogState {
  const row = getSetting<Partial<OpenRouterCatalogState>>(
    db,
    OPENROUTER_CATALOG_NAMESPACE,
  );
  if (!row || !row.value || typeof row.value !== "object") {
    return { ...EMPTY_OPENROUTER_CATALOG_STATE, models: {} };
  }
  const raw = row.value;
  const models = sanitizeModelsMap(raw.models);
  const modelCount = Object.keys(models).length;
  const status: OpenRouterCatalogSyncStatus =
    raw.status === "ok" || raw.status === "error" || raw.status === "idle"
      ? raw.status
      : "idle";
  return {
    models,
    modelCount,
    snapshotVersion:
      typeof raw.snapshotVersion === "string" && raw.snapshotVersion
        ? raw.snapshotVersion
        : null,
    status,
    lastAttemptAt:
      typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
    lastSuccessAt:
      typeof raw.lastSuccessAt === "string" ? raw.lastSuccessAt : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    refreshLockUntil:
      typeof raw.refreshLockUntil === "string" ? raw.refreshLockUntil : null,
    refreshLockOwner:
      typeof raw.refreshLockOwner === "string" ? raw.refreshLockOwner : null,
  };
}

export function getOpenRouterCatalogSnapshot(
  db: Database.Database,
): OpenRouterCatalogSnapshot {
  const state = getOpenRouterCatalogState(db);
  return {
    models: state.models,
    snapshotVersion: state.snapshotVersion,
  };
}

export interface OpenRouterCatalogStatusView {
  status: OpenRouterCatalogSyncStatus;
  modelCount: number;
  snapshotVersion: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export function getOpenRouterCatalogStatus(
  db: Database.Database,
): OpenRouterCatalogStatusView {
  const state = getOpenRouterCatalogState(db);
  return {
    status: state.status,
    modelCount: state.modelCount,
    snapshotVersion: state.snapshotVersion,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
  };
}

export interface Stage2EffectivePricingSummary {
  effective: Stage2ResolvedRate;
  catalog: OpenRouterCatalogStatusView;
}

export function getStage2EffectivePricingSummary(
  db: Database.Database,
  llm: Pick<
    Stage2LlmConfig,
    | "baseUrl"
    | "model"
    | "inputUsdPerMillion"
    | "outputUsdPerMillion"
    | "openRouterModelId"
  >,
): Stage2EffectivePricingSummary {
  const state = getOpenRouterCatalogState(db);
  const effective = resolveStage2Rates({
    baseUrl: llm.baseUrl,
    requestedModel: llm.model,
    responseModel: null,
    manualInputUsdPerMillion: llm.inputUsdPerMillion,
    manualOutputUsdPerMillion: llm.outputUsdPerMillion,
    openRouterModelId: llm.openRouterModelId,
    catalog: {
      models: state.models,
      snapshotVersion: state.snapshotVersion,
    },
  });
  return {
    effective,
    catalog: {
      status: state.status,
      modelCount: state.modelCount,
      snapshotVersion: state.snapshotVersion,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
    },
  };
}

type AcquireResult =
  | { acquired: true; owner: string }
  | { acquired: false; reason: "fresh" | "backoff" | "locked" };

function acquireCatalogRefreshLock(
  db: Database.Database,
  now: Date,
  force: boolean,
): AcquireResult {
  const tx = db.transaction((): AcquireResult => {
    const current = getOpenRouterCatalogState(db);
    const nowMs = now.getTime();

    if (current.refreshLockUntil) {
      const lockMs = Date.parse(current.refreshLockUntil);
      if (Number.isFinite(lockMs) && lockMs > nowMs) {
        return { acquired: false, reason: "locked" };
      }
    }

    if (!force) {
      if (current.lastSuccessAt) {
        const lastSuccessMs = Date.parse(current.lastSuccessAt);
        if (
          Number.isFinite(lastSuccessMs) &&
          nowMs - lastSuccessMs < OPENROUTER_REFRESH_SUCCESS_TTL_MS
        ) {
          return { acquired: false, reason: "fresh" };
        }
      }
      if (current.status === "error" && current.lastAttemptAt) {
        const lastAttemptMs = Date.parse(current.lastAttemptAt);
        if (
          Number.isFinite(lastAttemptMs) &&
          nowMs - lastAttemptMs < OPENROUTER_REFRESH_FAILURE_TTL_MS
        ) {
          return { acquired: false, reason: "backoff" };
        }
      }
    }

    const owner = `openrouter-sync-${randomUUID()}`;
    const nextState: OpenRouterCatalogState = {
      ...current,
      refreshLockUntil: new Date(nowMs + OPENROUTER_REFRESH_LOCK_MS).toISOString(),
      refreshLockOwner: owner,
    };
    setSetting(db, OPENROUTER_CATALOG_NAMESPACE, nextState);
    return { acquired: true, owner };
  });

  return tx.immediate();
}

function commitCatalogSuccess(
  db: Database.Database,
  owner: string,
  models: Record<string, OpenRouterModelPrice>,
  modelCount: number,
  now: Date,
): void {
  const nowIso = now.toISOString();
  const tx = db.transaction(() => {
    const current = getOpenRouterCatalogState(db);
    const clearLock = current.refreshLockOwner === owner;
    const nextState: OpenRouterCatalogState = {
      models,
      modelCount,
      snapshotVersion: `openrouter-${nowIso}`,
      status: "ok",
      lastAttemptAt: nowIso,
      lastSuccessAt: nowIso,
      lastError: null,
      refreshLockUntil: clearLock ? null : current.refreshLockUntil,
      refreshLockOwner: clearLock ? null : current.refreshLockOwner,
    };
    setSetting(db, OPENROUTER_CATALOG_NAMESPACE, nextState);
  });
  tx.immediate();
}

function commitCatalogFailure(
  db: Database.Database,
  owner: string,
  errorMessage: string,
  now: Date,
): void {
  const nowIso = now.toISOString();
  const tx = db.transaction(() => {
    const current = getOpenRouterCatalogState(db);
    const clearLock = current.refreshLockOwner === owner;
    // 失败时保留最近一次成功的快照与模型映射，仅更新同步状态。
    const nextState: OpenRouterCatalogState = {
      ...current,
      status: "error",
      lastAttemptAt: nowIso,
      lastError: errorMessage,
      refreshLockUntil: clearLock ? null : current.refreshLockUntil,
      refreshLockOwner: clearLock ? null : current.refreshLockOwner,
    };
    setSetting(db, OPENROUTER_CATALOG_NAMESPACE, nextState);
  });
  tx.immediate();
}

export interface SyncOpenRouterCatalogOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SyncOpenRouterCatalogResult {
  synced: boolean;
  skippedReason?: "fresh" | "backoff" | "locked";
  modelCount: number;
  error: string | null;
}

/**
 * 同步 OpenRouter 公开模型价格目录。
 * - 常规调度（`force: false`）：成功后 24h 内跳过，失败后 1h 内跳过；
 * - 手动同步（`force: true`）：忽略 TTL，但仍遵守跨进程刷新占位锁防止并发重叠写入；
 * - 网络请求在事务外执行，复用 `fetchJev` 代理传输。
 */
export async function syncOpenRouterCatalog(
  db: Database.Database,
  options: SyncOpenRouterCatalogOptions = {},
): Promise<SyncOpenRouterCatalogResult> {
  const nowFn = options.now ?? (() => new Date());
  const force = options.force === true;
  const timeoutMs = options.timeoutMs ?? OPENROUTER_FETCH_TIMEOUT_MS;

  const lock = acquireCatalogRefreshLock(db, nowFn(), force);
  if (!lock.acquired) {
    const current = getOpenRouterCatalogState(db);
    return {
      synced: false,
      skippedReason: lock.reason,
      modelCount: current.modelCount,
      error: null,
    };
  }

  const controller = new AbortController();
  const onExternalAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const init: RequestInit = {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    };
    const res = options.fetchImpl
      ? await options.fetchImpl(OPENROUTER_MODELS_API_URL, init)
      : await fetchJev(OPENROUTER_MODELS_API_URL, init);

    if (!res.ok) {
      const errMsg = `OpenRouter 目录请求失败（HTTP ${res.status}）`;
      commitCatalogFailure(db, lock.owner, errMsg, nowFn());
      const current = getOpenRouterCatalogState(db);
      return {
        synced: false,
        modelCount: current.modelCount,
        error: errMsg,
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await res.json();
    } catch {
      const errMsg = "OpenRouter 目录返回了非 JSON 响应";
      commitCatalogFailure(db, lock.owner, errMsg, nowFn());
      const current = getOpenRouterCatalogState(db);
      return {
        synced: false,
        modelCount: current.modelCount,
        error: errMsg,
      };
    }

    const decoded = decodeOpenRouterModelsPayload(rawJson);
    if (!decoded.ok) {
      commitCatalogFailure(db, lock.owner, decoded.error, nowFn());
      const current = getOpenRouterCatalogState(db);
      return {
        synced: false,
        modelCount: current.modelCount,
        error: decoded.error,
      };
    }

    commitCatalogSuccess(
      db,
      lock.owner,
      decoded.models,
      decoded.modelCount,
      nowFn(),
    );
    return {
      synced: true,
      modelCount: decoded.modelCount,
      error: null,
    };
  } catch (err) {
    const errMsg = describeNetworkFailure(err, {
      service: "OpenRouter 价格目录",
      target: "https://openrouter.ai",
      timeoutMs,
      timeoutHint: "请检查网络连接或代理配置后重试",
      unreachableHint: "请检查出网网络与代理设置（JEV_PROXY_URL）",
    });
    commitCatalogFailure(db, lock.owner, errMsg, nowFn());
    const current = getOpenRouterCatalogState(db);
    return {
      synced: false,
      modelCount: current.modelCount,
      error: errMsg,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
