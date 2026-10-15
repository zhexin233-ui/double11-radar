import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  claimJob,
  completeJob,
  failJob,
  getJob,
  isJobOwnedBy,
  requeueJob,
} from "@/lib/db/repos/jobs";
import { getBulletin } from "@/lib/db/repos/bulletins";
import {
  listEvaluationsByBulletin,
  upsertEvaluation,
} from "@/lib/db/repos/evaluations";
import { listEnabledNeeds } from "@/lib/db/repos/needs";
import { reclaimExpiredRequestReservations } from "@/lib/db/repos/jev-requests";
import { type callSystemOne } from "@/lib/jev/client";
import { buildQuestions, buildState, parseAnswers } from "@/lib/jev/prompt";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import { getJevConfig, getJevConfigView } from "@/lib/service/config";
import {
  JevCallBlockedError,
  callJevWithLedger,
} from "@/lib/service/jev-requests";
import { patchRuntimeState } from "@/lib/worker/runtime-state";
import { RULE_VERSION } from "@/lib/domain/constants";
import type { AppEnv } from "@/lib/env";
import type { EvaluationResult } from "@/lib/domain/types";

/**
 * 判断循环。
 *
 * 只有 `matched` 才创建通知与投递；`uncertain` 仅保留待确认记录；
 * `not_matched` 只保存记录；模型调用失败或结构不合法记为 `failed` 并有限重试，
 * **绝不伪造命中**。
 *
 * 租约与并发（本任务修订）：
 * - 每个执行槽在处理前才 `claimJob`，不提前领取整个等待队列，避免排队任务白耗租约；
 * - 租约至少覆盖配置超时 + 收尾余量，正常调用期间不会被回收；
 * - 每次 claim 有独立 owner，落判断/通知前校验仍持有该租约，失去 ownership 的旧结果
 *   不能覆盖新 owner 的判断；
 * - 「没有发出上游请求」的阻塞（容量满、共享退避、无可用 Key）只延后重排，不耗尽尝试次数。
 */

/** 执行租约在请求超时之外额外覆盖的收尾余量（解析答案 + 落库 + 通知事务）。 */
export const JOB_LEASE_MARGIN_MS = 30_000;

/** 容量暂满 / 共享退避时的轻量延后间隔。 */
export const JOB_BUSY_RETRY_MS = 5_000;

export interface EvaluatorDeps {
  callSystemOne?: typeof callSystemOne;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface EvaluatorRoundResult {
  processed: number;
  matched: number;
  uncertain: number;
  failed: number;
  /** 因容量/退避/无可用 Key 而未发出请求、已延后重排的任务数。 */
  deferred: number;
}

interface EvaluateOutcome {
  /** 判断结果是否真正落库（失去 job ownership 时为 false）。 */
  persisted: boolean;
  result: EvaluationResult | null;
  matched: number;
}

async function evaluateJob(
  db: Database.Database,
  jobId: string,
  owner: string,
  bulletinId: string,
  deps: EvaluatorDeps,
): Promise<EvaluateOutcome> {
  const bulletin = getBulletin(db, bulletinId);
  if (!bulletin) {
    return { persisted: false, result: null, matched: 0 };
  }
  const needs = listEnabledNeeds(db);
  if (needs.length === 0) {
    return { persisted: false, result: null, matched: 0 };
  }

  const configVersion = getJevConfigView(db).version;
  const { questions, needByQuestionId } = buildQuestions(needs);
  const state = buildState(bulletin);

  // 统一服务负责容量、Key 选择、失败计数与用量账本；一次调用最多计一次失败。
  const outcome = await callJevWithLedger(
    db,
    {
      purpose: "evaluate",
      state,
      questions,
      bulletinId: bulletin.id,
      jobId,
    },
    {
      ...(deps.callSystemOne ? { callSystemOne: deps.callSystemOne } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );

  if (outcome.status === "blocked") {
    throw new JevCallBlockedError(outcome.block);
  }
  if (outcome.status === "failed") {
    // 实际请求失败：抛出类型化错误，由调用方按普通退避重排（下次可选其它 Key）。
    throw outcome.error;
  }

  const questionIds = Object.keys(questions);
  const answers = parseAnswers(outcome.response, questionIds);

  let matched = 0;
  let uncertain = 0;
  let failedCount = 0;

  // 一次多问题请求最多计一次调用失败，但每条需求的答案独立落库。
  const persist = db.transaction((): boolean => {
    // 失去本次 job 租约（例如另一连接已回收并重新领取）时不得落判断/通知。
    if (!isJobOwnedBy(db, jobId, owner)) return false;
    for (const questionId of questionIds) {
      const need = needByQuestionId.get(questionId);
      if (!need) continue;
      const answer = answers[questionId];
      upsertEvaluation(db, {
        bulletinId: bulletin.id,
        needId: need.id,
        needName: need.name,
        needNote: need.note,
        needVersion: need.version,
        configVersion,
        ruleVersion: RULE_VERSION,
        result: answer.result,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        rawAnswer: answer.raw,
        error: answer.error,
      });
      if (answer.result === "matched") matched += 1;
      else if (answer.result === "uncertain") uncertain += 1;
      else if (answer.result === "failed") failedCount += 1;
    }

    if (matched > 0) {
      const matchedEvaluations = listEvaluationsByBulletin(db, bulletin.id).filter(
        (evaluation) => evaluation.result === "matched",
      );
      createNotificationAndDeliveries(db, bulletin, matchedEvaluations);
    }
    return true;
  });
  const persisted = persist.immediate();

  if (!persisted) {
    return { persisted: false, result: null, matched: 0 };
  }

  return {
    persisted: true,
    result:
      matched > 0
        ? "matched"
        : uncertain > 0
          ? "uncertain"
          : failedCount > 0
            ? "failed"
            : "not_matched",
    matched,
  };
}

export async function runEvaluatorOnce(
  db: Database.Database,
  _env: AppEnv,
  deps: EvaluatorDeps = {},
): Promise<EvaluatorRoundResult> {
  const now = deps.now?.() ?? new Date();
  const stats: EvaluatorRoundResult = {
    processed: 0,
    matched: 0,
    uncertain: 0,
    failed: 0,
    deferred: 0,
  };
  const errors: string[] = [];

  // 每轮重新读取调度设置，网页改完立即生效，无需重启 worker。
  const config = getJevConfig(db);

  // 超期请求预留转为 interrupted：释放容量、费用未知，迟到真实结果仍可补写一次。
  reclaimExpiredRequestReservations(db, now);

  // 租约必须覆盖请求超时 + 收尾余量，否则正常调用会在途中被回收。
  const leaseMs = config.timeoutMs + JOB_LEASE_MARGIN_MS;

  /** 处理一个已领取的任务（含解析、跳过基线与失败分类）。 */
  const processJob = async (jobId: string, owner: string): Promise<void> => {
    const job = getJob(db, jobId);
    if (!job) return;
    let payload: { bulletinId?: string };
    try {
      payload = JSON.parse(job.payload) as { bulletinId?: string };
    } catch {
      completeJob(db, job.id, owner);
      return;
    }
    if (!payload.bulletinId) {
      completeJob(db, job.id, owner);
      return;
    }
    const bulletin = getBulletin(db, payload.bulletinId);
    if (!bulletin || bulletin.baseline) {
      completeJob(db, job.id, owner);
      return;
    }

    try {
      const outcome = await evaluateJob(db, job.id, owner, payload.bulletinId, deps);
      completeJob(db, job.id, owner);
      if (!outcome.persisted) return;
      stats.processed += 1;
      stats.matched += outcome.matched;
      if (outcome.result === "uncertain") stats.uncertain += 1;
      if (outcome.result === "failed") stats.failed += 1;
    } catch (error) {
      if (error instanceof JevCallBlockedError) {
        // 没有发出上游请求：配置类问题保持永久可恢复（只累计 attempts 供观察），
        // 容量/退避只短暂延后，都不计入线报本身失败。
        if (error.isConfigProblem) {
          failJob(db, job.id, error.message, now, { permanentRetry: true, owner });
        } else {
          const delayMs = error.retryAfterMs ?? JOB_BUSY_RETRY_MS;
          requeueJob(
            db,
            job.id,
            owner,
            error.message,
            new Date(now.getTime() + delayMs),
            now,
          );
        }
        stats.deferred += 1;
        errors.push(`判断延后：${error.message}`);
        return;
      }
      const message =
        error instanceof Error
          ? `判断调用出现未预期异常：${error.message}`
          : `判断调用出现未预期异常：${String(error)}`;
      failJob(db, job.id, message, now, { owner });
      errors.push(`判断失败：${message}`);
      stats.failed += 1;
    }
  };

  // 按执行槽领取：每个槽处理完一个任务才领下一个，队列中的任务不占用租约。
  let processedSlots = 0;
  const laneCount = Math.max(1, Math.min(config.concurrency, config.jobsPerRound));
  await Promise.all(
    Array.from({ length: laneCount }, async () => {
      for (;;) {
        // 检查与自增之间没有 await，多个执行槽不会超领。
        if (processedSlots >= config.jobsPerRound) break;
        const job = claimJob(db, `evaluator:${randomUUID()}`, leaseMs, now, "evaluate");
        if (!job) break;
        processedSlots += 1;
        await processJob(job.id, job.leaseOwner ?? "");
      }
    }),
  );

  patchRuntimeState(db, {
    lastEvaluateAt: now.toISOString(),
    ...(errors.length > 0
      ? {
          lastError: errors[0],
          lastErrorAt: now.toISOString(),
          lastErrorStage: "evaluate",
        }
      : {}),
  });
  return stats;
}
