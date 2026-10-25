import type Database from "better-sqlite3";
import {
  completeJevRequest,
  countActiveInFlight,
  countInFlightByKey,
  insertInFlightRequest,
  reclaimExpiredRequestReservations,
} from "@/lib/db/repos/jev-requests";
import { listJevKeys, touchJevKeyUsed } from "@/lib/db/repos/jev-keys";
import { extendJobLease, isJobOwnedBy } from "@/lib/db/repos/jobs";
import { getJevCooldown, isJevCoolingDown } from "@/lib/db/repos/jev-cooldown";
import { getActiveModelChannel } from "@/lib/db/repos/model-channels";
import {
  getJevConfig,
  getJevConfigView,
  listJevRuntimeKeys,
} from "@/lib/service/config";
import { providerOriginFromBaseUrl } from "@/lib/jev/pricing";
import {
  JevError,
  callSystemOne,
  type SystemOneRequest,
} from "@/lib/jev/client";
import type { SystemOneResponse } from "@/lib/jev/types";
import type { JevRequestPurpose } from "@/lib/domain/types";

/**
 * 统一 Jev 请求服务：Key 选择、全局容量、调用生命周期与用量账本。
 *
 * 所有实际上游调用（生产判断 / 连接测试 / 需求试判、以及每次重试）都必须经过这里，
 * 从而保证：
 * - 全局并发是所有入口共享的**持久化**容量，web 与 worker 不会各自超额；
 * - 每次调用先写 `in_flight` 预留再发网络请求，响应回来才落账，进程中断不会伪造零账单；
 * - 未发出上游请求的「阻塞」（容量满、限流退避、无可用 Key）不计失败、不计费；
 * - 结果落账与 Key 健康计数在同一事务内完成（见 `lib/db/repos/jev-requests.ts`）。
 *
 * 严禁在预留事务里 `await` 网络：事务只做同步的状态选择与写预留，网络调用在事务之外。
 */

/** 请求预留租约在配置超时之外额外覆盖的收尾余量。 */
export const JE_REQUEST_LEASE_MARGIN_MS = 30_000;

/** 预留租约必须覆盖「请求超时 + 收尾」，否则会在正常调用期间被当作中断回收。 */
export function jevRequestLeaseMs(timeoutMs: number): number {
  return timeoutMs + JE_REQUEST_LEASE_MARGIN_MS;
}

/** 没有真正发出上游请求的阻塞原因。 */
export type JevBlockReason =
  | "not_configured"
  | "no_key"
  | "busy"
  | "cooldown"
  | "key_disabled"
  | "key_unreadable"
  | "key_missing"
  | "lease_lost";

/**
 * 一次调用的非敏感语义配置标识。
 * 只比较标准化 baseUrl 与 model（普通并发/超时/Key 元数据变化不会因
 * configVersion 自增而被误判成语义变化），供门控否定结果的失效判断。
 */
export interface JevSemanticConfig {
  baseUrl: string;
  model: string;
  configVersion: number | null;
}

/** 标准化服务地址：去掉尾部斜杠，便于语义比较。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export interface JevCallBlocked {
  ok: false;
  reason: JevBlockReason;
  /** 面向管理员的中文说明。 */
  message: string;
  /** 建议的延后重试毫秒数（若上游给出 Retry-After 则为其值）。 */
  retryAfterMs: number | null;
}

export interface JevCallReservation {
  requestId: string;
  keyId: string;
  keyLabel: string;
  keyGeneration: number;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  providerOrigin: string | null;
  configVersion: number | null;
  semanticConfig: JevSemanticConfig;
  startedAt: Date;
}

export interface JevReserveOk {
  ok: true;
  reservation: JevCallReservation;
}

export type JevReserveResult = JevReserveOk | JevCallBlocked;

export interface JevReserveInput {
  purpose: JevRequestPurpose;
  bulletinId?: string | null;
  jobId?: string | null;
  /** 所属处理 run / 子批（三模式追溯）。 */
  evaluationRunId?: string | null;
  batchPartId?: string | null;
  /** 受信任的任务 owner；提供时会在预留事务内校准任务租约。 */
  jobOwner?: string | null;
  /** 指定 Key（连接测试用）：必须是当前启用且可解密的 Key，不隐式启用。 */
  preferredKeyId?: string | null;
  now?: Date;
}

function blocked(
  reason: JevBlockReason,
  message: string,
  retryAfterMs: number | null = null,
): JevCallBlocked {
  return { ok: false, reason, message, retryAfterMs };
}

/** Key 上持久化的冷却截止时间是否仍有效。 */
function isKeyCoolingDown(cooldownUntil: string | null, now: Date): boolean {
  if (!cooldownUntil) return false;
  const deadline = new Date(cooldownUntil).getTime();
  if (Number.isNaN(deadline)) return false;
  return deadline > now.getTime();
}

/**
 * 预留一次调用（同步、`BEGIN IMMEDIATE`）。
 *
 * 顺序：回收超期预留 → 读取配置与可用 Key → 检查全局容量 → 检查共享退避 →
 * 按「在途最少、最久未用、id 稳定」选 Key → 写入 `in_flight` 并更新 last_used_at。
 */
export function reserveJevCall(
  db: Database.Database,
  input: JevReserveInput,
  key?: Buffer,
): JevReserveResult {
  const now = input.now ?? new Date();
  const run = db.transaction((): JevReserveResult => {
    // 超期预留转为 interrupted：释放容量、费用未知，但允许迟到真实结果补写一次。
    reclaimExpiredRequestReservations(db, now);

    const config = getJevConfig(db);
    // 优先根据当前活动渠道及 baseUrl 匹配可用密钥
    const activeChannel = getActiveModelChannel(db);
    const channelId = activeChannel ? activeChannel.id : null;
    const currentNormBaseUrl = normalizeBaseUrl(config.baseUrl);

    const allKeys = listJevKeys(db).filter((k) => {
      if (channelId && k.channelId === channelId) return true;
      if (k.baseUrl && normalizeBaseUrl(k.baseUrl) === currentNormBaseUrl) return true;
      // 容错：如果既无 channelId 又无 baseUrl，作为遗留默认 Key 允许在未指定特殊渠道时匹配
      return !k.channelId && !k.baseUrl;
    });

    if (allKeys.length === 0) {
      return blocked(
        "not_configured",
        "Jev 未配置 API 密钥（当前服务渠道未配置 API 密钥，请在模型配置的「API 密钥」面板为该渠道添加密钥后重试）",
      );
    }

    const runtimeKeys = listJevRuntimeKeys(db, key);
    let candidates = runtimeKeys;

    if (input.preferredKeyId) {
      const row = allKeys.find((item) => item.id === input.preferredKeyId);
      if (!row) return blocked("key_missing", "指定的 Jev 密钥不存在");
      if (!row.enabled) {
        return blocked(
          "key_disabled",
          "该密钥已被禁用，请先在页面恢复后再测试",
        );
      }
      const runtime = runtimeKeys.find((item) => item.id === row.id);
      if (!runtime) {
        return blocked(
          "key_unreadable",
          "该密钥无法解密（加密密钥可能已变更），请替换后再测试",
        );
      }
      candidates = [runtime];
    }

    if (candidates.length === 0) {
      const hasUnreadable = allKeys.some(
        (item) =>
          item.enabled && !runtimeKeys.some((runtime) => runtime.id === item.id),
      );
      return blocked(
        "no_key",
        hasUnreadable
          ? "已保存的 Jev 密钥无法解密（加密密钥可能已变更），请重新保存密钥"
          : "Jev 密钥均不可用（已禁用或未配置），请在页面恢复或替换密钥",
      );
    }

    // 全局容量：所有入口共享，包含连接测试与试判；达到上限不发请求、不计费。
    if (countActiveInFlight(db, now) >= config.concurrency) {
      return blocked(
        "busy",
        `Jev 并发已达上限（${config.concurrency}），本次调用稍后重试`,
      );
    }

    // 共享退避：多 Key 可能共享账号限额，退避期间轮换 Key 也不会发请求。
    if (isJevCoolingDown(db, now)) {
      const cooldown = getJevCooldown(db);
      const message = cooldown.until
        ? `Jev 正在限流退避（至 ${cooldown.until}），稍后自动重试`
        : "Jev 正在限流退避，稍后自动重试";
      return blocked("cooldown", message);
    }

    const available = candidates.filter((runtime) => {
      const row = allKeys.find((item) => item.id === runtime.id);
      return !isKeyCoolingDown(row?.cooldownUntil ?? null, now);
    });
    if (available.length === 0) {
      return blocked(
        "cooldown",
        "所有可用 Jev 密钥都在限流退避中，稍后自动重试",
      );
    }

    // 最低负载优先：在途最少 → 最久未用 → id 稳定，保证多 Key 均匀分摊。
    const inFlight = countInFlightByKey(db, now);
    const sorted = [...available].sort((left, right) => {
      const loadDiff =
        (inFlight.get(left.id) ?? 0) - (inFlight.get(right.id) ?? 0);
      if (loadDiff !== 0) return loadDiff;
      const leftRow = allKeys.find((item) => item.id === left.id);
      const rightRow = allKeys.find((item) => item.id === right.id);
      const leftUsed = leftRow?.lastUsedAt
        ? new Date(leftRow.lastUsedAt).getTime()
        : 0;
      const rightUsed = rightRow?.lastUsedAt
        ? new Date(rightRow.lastUsedAt).getTime()
        : 0;
      if (leftUsed !== rightUsed) return leftUsed - rightUsed;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const chosen = sorted[0];
    const chosenRow = allKeys.find((item) => item.id === chosen.id);
    if (!chosenRow) return blocked("no_key", "选中的 Jev 密钥已不存在");

    const configVersion = getJevConfigView(db).version;
    const providerOrigin = providerOriginFromBaseUrl(config.baseUrl);
    const semanticConfig: JevSemanticConfig = {
      baseUrl: normalizeBaseUrl(config.baseUrl),
      model: config.model,
      configVersion,
    };
    // 按本次真正选定的 timeoutMs 校准任务租约；失去 owner 时绝不发送请求。
    if (input.jobId && input.jobOwner) {
      if (!isJobOwnedBy(db, input.jobId, input.jobOwner)) {
        return blocked(
          "lease_lost",
          "任务租约已失效，本次调用不再发送，交由新租约处理",
        );
      }
      extendJobLease(
        db,
        input.jobId,
        new Date(now.getTime() + jevRequestLeaseMs(config.timeoutMs)),
        now,
      );
    }
    const reserved = insertInFlightRequest(db, {
      channelId,
      baseUrl: config.baseUrl,
      keyId: chosenRow.id,
      keyLabel: chosenRow.label,
      keyGeneration: chosenRow.generation,
      purpose: input.purpose,
      bulletinId: input.bulletinId ?? null,
      jobId: input.jobId ?? null,
      evaluationRunId: input.evaluationRunId ?? null,
      batchPartId: input.batchPartId ?? null,
      requestedModel: config.model,
      providerOrigin,
      configVersion,
      startedAt: now,
      leaseUntil: new Date(now.getTime() + jevRequestLeaseMs(config.timeoutMs)),
    });
    touchJevKeyUsed(db, chosenRow.id, now);

    return {
      ok: true,
      reservation: {
        requestId: reserved.id,
        keyId: chosenRow.id,
        keyLabel: chosenRow.label,
        keyGeneration: chosenRow.generation,
        apiKey: chosen.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        providerOrigin,
        configVersion,
        semanticConfig,
        startedAt: now,
      },
    };
  });
  return run.immediate();
}

export interface JevCallSucceeded {
  status: "succeeded";
  requestId: string;
  keyId: string;
  keyLabel: string;
  response: SystemOneResponse;
  keyDisabled: boolean;
  semanticConfig: JevSemanticConfig;
}

export interface JevCallFailed {
  status: "failed";
  requestId: string;
  keyId: string;
  keyLabel: string;
  error: JevError;
  keyDisabled: boolean;
  semanticConfig: JevSemanticConfig;
}

export interface JevCallBlockedOutcome {
  status: "blocked";
  block: JevCallBlocked;
}

export type JevCallOutcome =
  | JevCallSucceeded
  | JevCallFailed
  | JevCallBlockedOutcome;

export interface JevCallRequest {
  purpose: JevRequestPurpose;
  state: string;
  questions: SystemOneRequest["questions"];
  bulletinId?: string | null;
  jobId?: string | null;
  /** 受信任的任务 owner；提供时会在预留事务内校准任务租约。 */
  jobOwner?: string | null;
  evaluationRunId?: string | null;
  batchPartId?: string | null;
  preferredKeyId?: string | null;
  /**
   * 仅在受信服务端调用时使用的响应校验：在记录成功前验证业务完整性。
   * 返回不合法时按「一次实际失败」落账（保留 usage/model/request id），
   * 调用方据此回退逐条，不做事后二次计失败。
   */
  validateResponse?: (
    response: SystemOneResponse,
  ) => { ok: true } | { ok: false; error: string };
}

export interface JevCallDeps {
  fetchImpl?: typeof fetch;
  callSystemOne?: typeof callSystemOne;
  now?: () => Date;
  key?: Buffer;
  signal?: AbortSignal;
}

/**
 * 读取响应元数据。官方协议允许用量未报告；注入的传输实现也可能只返回 answers，
 * 因此缺失字段一律按「未知」处理，绝不用 0 冒充用量。
 */
function readResponseMeta(response: SystemOneResponse): {
  upstreamRequestId: string | null;
  responseModel: string | null;
  httpStatus: number | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
} {
  return {
    upstreamRequestId: response.upstreamRequestId ?? null,
    responseModel: response.model ?? null,
    httpStatus: response.httpStatus ?? null,
    usage: response.usage ?? { inputTokens: null, outputTokens: null },
  };
}

/**
 * 执行一次带账本的 Jev 调用。
 *
 * 返回三类结果：`succeeded` / `failed`（均已落账并更新 Key 健康计数）、
 * `blocked`（没有发出上游请求，不计失败、不计费）。
 * 非 `JevError` 的未知异常仍会把预留落成失败（避免容量泄漏）后原样抛出。
 */
export async function callJevWithLedger(
  db: Database.Database,
  request: JevCallRequest,
  deps: JevCallDeps = {},
): Promise<JevCallOutcome> {
  const reserved = reserveJevCall(
    db,
    {
      purpose: request.purpose,
      bulletinId: request.bulletinId ?? null,
      jobId: request.jobId ?? null,
      evaluationRunId: request.evaluationRunId ?? null,
      batchPartId: request.batchPartId ?? null,
      jobOwner: request.jobOwner ?? null,
      preferredKeyId: request.preferredKeyId ?? null,
      now: deps.now?.() ?? new Date(),
    },
    deps.key,
  );
  if (!reserved.ok) return { status: "blocked", block: reserved };

  const { reservation } = reserved;
  const call = deps.callSystemOne ?? callSystemOne;

  try {
    const response = await call(
      {
        baseUrl: reservation.baseUrl,
        apiKey: reservation.apiKey,
        model: reservation.model,
        timeoutMs: reservation.timeoutMs,
      },
      {
        state: request.state,
        model: reservation.model,
        questions: request.questions,
      },
      {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
    const meta = readResponseMeta(response);
    // 受信服务端的业务校验：不合法时按一次实际失败落账（保留 usage/model/request id）。
    const validation = request.validateResponse?.(response);
    if (validation && !validation.ok) {
      const error = new JevError(`Jev 响应校验失败：${validation.error}`, {
        status: meta.httpStatus,
        retryable: false,
        code: "invalid_response",
        upstreamRequestId: meta.upstreamRequestId,
        responseModel: meta.responseModel,
        usage: meta.usage,
      });
      const failed = completeJevRequest(db, {
        id: reservation.requestId,
        status: "failed",
        now: deps.now?.() ?? new Date(),
        upstreamRequestId: meta.upstreamRequestId,
        responseModel: meta.responseModel,
        httpStatus: meta.httpStatus,
        errorCode: error.code,
        errorMessage: error.message,
        inputTokens: meta.usage.inputTokens,
        outputTokens: meta.usage.outputTokens,
      });
      return {
        status: "failed",
        requestId: reservation.requestId,
        keyId: reservation.keyId,
        keyLabel: reservation.keyLabel,
        error,
        keyDisabled: failed.keyDisabled,
        semanticConfig: reservation.semanticConfig,
      };
    }
    const completed = completeJevRequest(db, {
      id: reservation.requestId,
      status: "succeeded",
      now: deps.now?.() ?? new Date(),
      upstreamRequestId: meta.upstreamRequestId,
      responseModel: meta.responseModel,
      httpStatus: meta.httpStatus,
      inputTokens: meta.usage.inputTokens,
      outputTokens: meta.usage.outputTokens,
    });
    return {
      status: "succeeded",
      requestId: reservation.requestId,
      keyId: reservation.keyId,
      keyLabel: reservation.keyLabel,
      response,
      keyDisabled: completed.keyDisabled,
      semanticConfig: reservation.semanticConfig,
    };
  } catch (error) {
    const finishedAt = deps.now?.() ?? new Date();
    if (error instanceof JevError) {
      const completed = completeJevRequest(db, {
        id: reservation.requestId,
        status: "failed",
        now: finishedAt,
        upstreamRequestId: error.upstreamRequestId,
        responseModel: error.responseModel,
        httpStatus: error.status,
        errorCode: error.code,
        errorMessage: error.message,
        inputTokens: error.usage.inputTokens,
        outputTokens: error.usage.outputTokens,
        retryAfterMs: error.retryAfterMs,
        rateLimited: error.status === 429 || error.status === 529,
      });
      return {
        status: "failed",
        requestId: reservation.requestId,
        keyId: reservation.keyId,
        keyLabel: reservation.keyLabel,
        error,
        keyDisabled: completed.keyDisabled,
        semanticConfig: reservation.semanticConfig,
      };
    }
    // 未知异常：先把预留落成失败释放容量（用量未知），再交给调用方处理。
    completeJevRequest(db, {
      id: reservation.requestId,
      status: "failed",
      now: finishedAt,
      errorMessage: "Jev 调用出现未预期异常",
    });
    throw error;
  }
}

/**
 * 调用被阻塞（未发出上游请求）时抛出的类型化错误，供 worker 分类重排。
 *
 * 继承 `JevError`，因此已有的「配置问题可自动恢复」判断与路由错误处理无需改动；
 * `retryAfterMs` 直接复用父类字段（共享退避截止时间）。
 */
export class JevCallBlockedError extends JevError {
  readonly reason: JevBlockReason;

  constructor(block: JevCallBlocked) {
    super(block.message, {
      retryable: true,
      code: block.reason === "not_configured" ? "not_configured" : null,
      retryAfterMs: block.retryAfterMs,
    });
    this.name = "JevCallBlockedError";
    this.reason = block.reason;
  }

  /** 配置类问题（无可用 Key / 未配置）：恢复后应自动继续。 */
  get isConfigProblem(): boolean {
    return (
      this.reason === "not_configured" ||
      this.reason === "no_key" ||
      this.reason === "key_disabled" ||
      this.reason === "key_unreadable" ||
      this.reason === "key_missing"
    );
  }
}
