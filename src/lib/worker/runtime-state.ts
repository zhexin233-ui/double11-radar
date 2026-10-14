import type Database from "better-sqlite3";
import { getSetting, setSetting } from "@/lib/db/repos/settings";

/**
 * 后台运行状态（供网页展示「没有匹配」与「处理故障」的区分）。
 * 存储在 `settings('runtime')`，web 与 worker 共用持久化数据库。
 */

export const RUNTIME_SETTING_NAMESPACE = "runtime";

export interface RuntimeState {
  workerStartedAt: string | null;
  lastHeartbeatAt: string | null;
  lastCollectAt: string | null;
  lastEvaluateAt: string | null;
  lastDeliverAt: string | null;
  lastMetaSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorStage: string | null;
  /** 站点限流额度耗尽时的全局暂停截止时间（UTC ISO8601）。 */
  rateLimitBackoffUntil: string | null;
  /** 最近一次响应头里的剩余额度，用于展示与判断。 */
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export const EMPTY_RUNTIME_STATE: RuntimeState = {
  workerStartedAt: null,
  lastHeartbeatAt: null,
  lastCollectAt: null,
  lastEvaluateAt: null,
  lastDeliverAt: null,
  lastMetaSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  lastErrorStage: null,
  rateLimitBackoffUntil: null,
  rateLimitRemaining: null,
  rateLimitResetAt: null,
};

export function getRuntimeState(db: Database.Database): RuntimeState {
  const record = getSetting<Partial<RuntimeState>>(
    db,
    RUNTIME_SETTING_NAMESPACE,
  );
  return { ...EMPTY_RUNTIME_STATE, ...(record?.value ?? {}) };
}

export function patchRuntimeState(
  db: Database.Database,
  patch: Partial<RuntimeState>,
): RuntimeState {
  const next = { ...getRuntimeState(db), ...patch };
  setSetting(db, RUNTIME_SETTING_NAMESPACE, next);
  return next;
}
