import type Database from "better-sqlite3";
import { claimJob, completeJob, failJob, getJob } from "@/lib/db/repos/jobs";
import { getBulletin } from "@/lib/db/repos/bulletins";
import {
  listEvaluationsByBulletin,
  upsertEvaluation,
} from "@/lib/db/repos/evaluations";
import { listEnabledNeeds } from "@/lib/db/repos/needs";
import {
  callSystemOne,
  JE_CONFIG_ERROR_CODES,
  JevError,
} from "@/lib/jev/client";
import {
  buildQuestions,
  buildState,
  parseAnswers,
} from "@/lib/jev/prompt";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import {
  getJevConfig,
  getJevConfigView,
  getJevRuntimeConfig,
} from "@/lib/service/config";
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
 */

const LEASE_MS = 60_000;

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
}

async function evaluateJob(
  db: Database.Database,
  bulletinId: string,
  deps: EvaluatorDeps,
): Promise<{ result: EvaluationResult | null; matched: number }> {
  const bulletin = getBulletin(db, bulletinId);
  if (!bulletin) {
    return { result: null, matched: 0 };
  }
  const needs = listEnabledNeeds(db);
  if (needs.length === 0) {
    return { result: null, matched: 0 };
  }

  const jevRuntime = getJevRuntimeConfig(db);
  if (!jevRuntime) {
    throw new JevError("Jev 未配置 API 密钥，请在网页配置后重试", {
      retryable: true,
      code: "not_configured",
    });
  }
  const configVersion = getJevConfigView(db).version;

  const { questions, needByQuestionId } = buildQuestions(needs);
  const state = buildState(bulletin);
  const call = deps.callSystemOne ?? callSystemOne;

  const response = await call(
    {
      baseUrl: jevRuntime.baseUrl,
      apiKey: jevRuntime.apiKey,
      model: jevRuntime.model,
      timeoutMs: jevRuntime.timeoutMs,
    },
    { state, model: jevRuntime.model, questions },
    deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
  );

  const questionIds = Object.keys(questions);
  const answers = parseAnswers(response, questionIds);

  let matched = 0;
  let uncertain = 0;
  let failedCount = 0;

  const persist = db.transaction(() => {
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
  });
  persist.immediate();

  return {
    result: matched > 0 ? "matched" : uncertain > 0 ? "uncertain" : failedCount > 0 ? "failed" : "not_matched",
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
  };
  const errors: string[] = [];

  // 每轮重新读取调度设置，网页改完立即生效，无需重启 worker。
  const { concurrency, jobsPerRound } = getJevConfig(db);

  // 先同步领取：claimJob 是带事务的同步操作，先领满再并发执行可避免竞态。
  const claimed: string[] = [];
  for (let i = 0; i < jobsPerRound; i += 1) {
    const job = claimJob(db, "evaluator", LEASE_MS, now, "evaluate");
    if (!job) break;
    claimed.push(job.id);
  }

  /** 处理一个已领取的任务（含解析、跳过基线与失败分类）。 */
  const processJob = async (jobId: string): Promise<void> => {
    const job = getJob(db, jobId);
    if (!job) return;
    let payload: { bulletinId?: string };
    try {
      payload = JSON.parse(job.payload) as { bulletinId?: string };
    } catch {
      completeJob(db, job.id);
      return;
    }
    if (!payload.bulletinId) {
      completeJob(db, job.id);
      return;
    }
    const bulletin = getBulletin(db, payload.bulletinId);
    if (!bulletin || bulletin.baseline) {
      completeJob(db, job.id);
      return;
    }

    try {
      const outcome = await evaluateJob(db, payload.bulletinId, deps);
      completeJob(db, job.id);
      stats.processed += 1;
      stats.matched += outcome.matched;
      if (outcome.result === "uncertain") stats.uncertain += 1;
      if (outcome.result === "failed") stats.failed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 配置问题（未配置密钥/密钥无效）保持可重试，用户配置正确后自动恢复。
      const isConfigError =
        error instanceof JevError &&
        error.code !== null &&
        JE_CONFIG_ERROR_CODES.has(error.code);
      failJob(db, job.id, message, now, { permanentRetry: isConfigError });
      errors.push(`判断失败：${message}`);
      stats.failed += 1;
    }
  };

  // 受限并发执行：最多 concurrency 条执行线，每条线串行取下一个任务。
  // 队列取用是同步的（检查与 shift 之间没有 await），因此不会重复取到同一任务。
  const queue = [...claimed];
  const laneCount = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(
    Array.from({ length: laneCount }, async () => {
      for (;;) {
        const jobId = queue.shift();
        if (!jobId) break;
        await processJob(jobId);
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
