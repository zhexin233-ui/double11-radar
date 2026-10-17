import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  claimJob,
  completeJob,
  enqueueJob,
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
import {
  excludeBatchPart,
  expandBatchPart,
  getBatchPart,
  getEvaluationRun,
  getProcessing,
  listProcessingByPart,
  updateProcessing,
  type ProcessingPatch,
} from "@/lib/db/repos/evaluation-runs";
import { reclaimExpiredRequestReservations } from "@/lib/db/repos/jev-requests";
import { type callSystemOne } from "@/lib/jev/client";
import {
  bulletinToMember,
  buildBatchGateRequest,
  parseBatchGateResponse,
} from "@/lib/jev/batch-prompt";
import { measureBatchGateBytes } from "@/lib/jev/batch-packing";
import { buildQuestions, buildState, parseAnswers } from "@/lib/jev/prompt";
import {
  MATCH_CONFIRMATION_POLICY,
  MATCH_CONFIRMATION_POLICY_VERSION,
  decideMatchConfirmation,
} from "@/lib/jev/match-policy";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import { buildRegexMatchText } from "@/lib/regex/rules";
import { getSharedRegexRunner, type RegexRunner } from "@/lib/service/regex-runner";
import { getJevConfig, getJevConfigView } from "@/lib/service/config";
import {
  JevCallBlockedError,
  callJevWithLedger,
  normalizeBaseUrl,
} from "@/lib/service/jev-requests";
import { patchRuntimeState } from "@/lib/worker/runtime-state";
import { MAX_BATCH_GATE_BYTES, RULE_VERSION } from "@/lib/domain/constants";
import type { AppEnv } from "@/lib/env";
import type {
  Bulletin,
  ChoiceOutcome,
  EvaluationResult,
  EvaluationRun,
  NeedSnapshot,
} from "@/lib/domain/types";

/**
 * 判断循环（三种自动处理模式）。
 *
 * - `individual`：每条新线报对全部启用需求调用一次 JEV（默认，兼容旧队列）；
 * - `batch_gate`：先做一次整体初筛；合法全否则结束，命中/可疑/失败则全成员逐条；
 * - `regex_gate`：先按 run 规则快照本地预筛；通过或回退才逐条，未匹配则不调用。
 *
 * 铁律（延续既有契约）：
 * - 只有 `matched` 才创建通知；`uncertain` 只保留；失败绝不伪装成未命中；
 * - 「没有发出上游请求」的阻塞（容量满、共享退避、无可用 Key）只延后重排；
 * - 本地过滤（批次全否 / 正则未匹配）不创建伪评价，来源可追溯；
 * - 每次 claim / 重排都使用当前注入时钟，租约在统一请求服务内按实际 timeout 校准。
 */

/** 执行租约在请求超时之外额外覆盖的收尾余量（解析答案 + 落库 + 通知事务）。 */
export const JOB_LEASE_MARGIN_MS = 30_000;

/** 容量暂满 / 共享退避时的轻量延后间隔。 */
export const JOB_BUSY_RETRY_MS = 5_000;

/** 批次预筛排除的中文说明（不得显示为模型逐条结论）。 */
export const BATCH_EXCLUDED_REASON = "由批次预筛判定，未进行逐条 JEV 判断";

export interface EvaluatorDeps {
  callSystemOne?: typeof callSystemOne;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 可注入的正则执行器；生产默认使用共享线程 runner。 */
  regexRunner?: RegexRunner;
}

export interface EvaluatorRoundResult {
  processed: number;
  matched: number;
  uncertain: number;
  failed: number;
  /** 因容量/退避/无可用 Key 而未发出请求、已延后重排的任务数。 */
  deferred: number;
  /** 实际执行的批次初筛调度任务数。 */
  gated: number;
  /** 由本地过滤（批次全否 / 正则未匹配）结束的成员数。 */
  filtered: number;
}

interface JobOutcome {
  /** 结果是否真正落库（失去 job ownership 时为 false）。 */
  persisted: boolean;
  result: EvaluationResult | null;
  matched: number;
  filtered?: boolean;
  /** 本地过滤结束的条目数（批次全否时为该批全部成员）。 */
  filteredCount?: number;
  gated?: boolean;
}

interface JobPayload {
  bulletinId?: string;
  partId?: string;
  evaluationRunId?: string;
}

function nowFrom(deps: EvaluatorDeps): Date {
  return deps.now?.() ?? new Date();
}

/** owner 守卫下更新单个成员处理阶段；失去租约返回 false。 */
function ownerGuardedProcessingUpdate(
  db: Database.Database,
  jobId: string,
  owner: string,
  bulletinId: string,
  patch: ProcessingPatch,
  nowIso: string,
): boolean {
  const run = db.transaction((): boolean => {
    if (!isJobOwnedBy(db, jobId, owner)) return false;
    updateProcessing(db, bulletinId, patch, nowIso);
    return true;
  });
  return run.immediate();
}

/** run 的需求来源：batch_gate 用冻结快照，其余模式仍取执行时启用需求。 */
function needsForRun(
  db: Database.Database,
  run: EvaluationRun | null,
): NeedSnapshot[] | ReturnType<typeof listEnabledNeeds> {
  if (run?.evaluationMode === "batch_gate" && run.needSnapshots) {
    return run.needSnapshots;
  }
  return listEnabledNeeds(db);
}

/** 正则预筛：pass/fallback 落 `ready`，未匹配落 `filtered`。 */
async function applyRegexScreen(
  db: Database.Database,
  jobId: string,
  owner: string,
  bulletin: Bulletin,
  run: EvaluationRun,
  deps: EvaluatorDeps,
): Promise<{ persisted: boolean; filtered: boolean }> {
  const nowIso = nowFrom(deps).toISOString();
  const rules = run.regexRules ?? [];
  if (rules.length === 0) {
    // 规则为空/结构异常：回退逐条，绝不用「没得到 true」当过滤。
    const persisted = ownerGuardedProcessingUpdate(
      db,
      jobId,
      owner,
      bulletin.id,
      {
        stage: "ready",
        screeningSource: "regex_gate",
        screeningReason: "正则规则为空或不可用，已回退逐条判断",
        matchedRuleIndex: null,
      },
      nowIso,
    );
    return { persisted, filtered: false };
  }

  const runner = deps.regexRunner ?? getSharedRegexRunner();
  const text = buildRegexMatchText({
    title: bulletin.title,
    content: bulletin.content,
    category: bulletin.category,
    brand: bulletin.brand,
    mall: bulletin.mall,
    price: bulletin.price,
  });
  const outcome = await runner.match(rules, text);

  if (!outcome.ok) {
    const persisted = ownerGuardedProcessingUpdate(
      db,
      jobId,
      owner,
      bulletin.id,
      {
        stage: "ready",
        screeningSource: "regex_gate",
        screeningReason: `正则执行异常，已回退逐条判断：${outcome.error}`,
        matchedRuleIndex: null,
      },
      nowIso,
    );
    return { persisted, filtered: false };
  }
  if (outcome.matched) {
    const persisted = ownerGuardedProcessingUpdate(
      db,
      jobId,
      owner,
      bulletin.id,
      {
        stage: "ready",
        screeningSource: "regex_gate",
        screeningReason: null,
        matchedRuleIndex: outcome.matchedRuleIndex,
      },
      nowIso,
    );
    return { persisted, filtered: false };
  }
  const persisted = ownerGuardedProcessingUpdate(
    db,
    jobId,
    owner,
    bulletin.id,
    {
      stage: "filtered",
      screeningSource: "regex_gate",
      screeningReason: "正则规则未匹配，未调用 JEV",
      matchedRuleIndex: null,
    },
    nowIso,
  );
  return { persisted, filtered: persisted };
}

async function evaluateJob(
  db: Database.Database,
  jobId: string,
  owner: string,
  bulletinId: string,
  runId: string | undefined,
  deps: EvaluatorDeps,
): Promise<JobOutcome> {
  const bulletin = getBulletin(db, bulletinId);
  if (!bulletin) {
    return { persisted: false, result: null, matched: 0 };
  }
  const processing = getProcessing(db, bulletinId);
  const run = runId ? getEvaluationRun(db, runId) : null;

  // 正则预筛只在该成员首次处理（stage=pending）时执行一次；
  // 通过/回退后落 `ready`，后续网络重试不再重复跑正则。
  if (
    run?.evaluationMode === "regex_gate" &&
    processing &&
    processing.stage === "pending"
  ) {
    const screened = await applyRegexScreen(db, jobId, owner, bulletin, run, deps);
    if (!screened.persisted) {
      return { persisted: false, result: null, matched: 0 };
    }
    if (screened.filtered) {
      return {
        persisted: true,
        result: null,
        matched: 0,
        filtered: true,
        filteredCount: 1,
      };
    }
  }

  const needs = needsForRun(db, run);
  if (needs.length === 0) {
    // 没有启用需求：不请求模型，也不把「没有需求」当成明确未命中。
    if (processing) {
      ownerGuardedProcessingUpdate(
        db,
        jobId,
        owner,
        bulletinId,
        {
          stage: "skipped_no_needs",
          screeningReason: "当前没有启用需求，未调用模型",
        },
        nowFrom(deps).toISOString(),
      );
    }
    return { persisted: false, result: null, matched: 0 };
  }

  const configVersionFallback = getJevConfigView(db).version;
  const { questions, needByQuestionId } = buildQuestions(needs);
  const state = buildState(bulletin);

  // 策略在逐条请求开始前捕获一次，响应后使用同一快照（改变参数必须提升版本）。
  const policySnapshot = MATCH_CONFIRMATION_POLICY;

  // 统一服务负责容量、Key 选择、失败计数与用量账本；一次调用最多计一次失败。
  const outcome = await callJevWithLedger(
    db,
    {
      purpose: "evaluate",
      state,
      questions,
      bulletinId: bulletin.id,
      jobId,
      jobOwner: owner,
      evaluationRunId: run?.id ?? null,
      batchPartId: processing?.batchPartId ?? null,
    },
    deps,
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
  // 落库使用实际调用的配置版本（请求期间配置变化也不会写错）；仅在缺失时回退到请求前快照。
  const configVersion =
    outcome.semanticConfig.configVersion ?? configVersionFallback;

  let matched = 0;
  let uncertain = 0;
  let failedCount = 0;
  const matchedNeedIds: string[] = [];
  const persistNow = nowFrom(deps).toISOString();

  // 一次多问题请求最多计一次调用失败，但每条需求的答案独立落库。
  const persist = db.transaction((): boolean => {
    // 失去本次 job 租约（例如另一连接已回收并重新领取）时不得落判断/通知。
    if (!isJobOwnedBy(db, jobId, owner)) return false;
    for (const questionId of questionIds) {
      const need = needByQuestionId.get(questionId);
      if (!need) continue;
      const answer = answers[questionId];
      // 共享纯决策函数：保留原始选择，必要时将 matched 降为待确认。
      const decision = decideMatchConfirmation(answer, policySnapshot);
      upsertEvaluation(db, {
        bulletinId: bulletin.id,
        needId: need.id,
        needName: need.name,
        needNote: need.note,
        needVersion: need.version,
        configVersion,
        ruleVersion: RULE_VERSION,
        result: decision.result,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        rawAnswer: answer.raw,
        error: answer.error,
        modelResult: decision.modelResult,
        decisionReason: decision.reason,
        decisionPolicyVersion: MATCH_CONFIRMATION_POLICY_VERSION,
        decisionPolicy: policySnapshot,
        jevRequestId: outcome.requestId,
      });
      if (decision.result === "matched") {
        matched += 1;
        matchedNeedIds.push(need.id);
      } else if (decision.result === "uncertain") uncertain += 1;
      else if (decision.result === "failed") failedCount += 1;
    }

    if (matchedNeedIds.length > 0) {
      // 只汇总本次真正落库的确认匹配项，禁止重扫全部历史 matched 混入旧项。
      const confirmed = new Set(matchedNeedIds);
      const matchedEvaluations = listEvaluationsByBulletin(db, bulletin.id).filter(
        (evaluation) =>
          evaluation.ruleVersion === RULE_VERSION &&
          evaluation.result === "matched" &&
          confirmed.has(evaluation.needId),
      );
      if (matchedEvaluations.length > 0) {
        createNotificationAndDeliveries(db, bulletin, matchedEvaluations);
      }
    }
    if (processing) {
      updateProcessing(
        db,
        bulletin.id,
        {
          stage:
            failedCount > 0 && matched === 0 && uncertain === 0
              ? "failed"
              : "evaluated",
        },
        persistNow,
      );
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

async function screenBatchJob(
  db: Database.Database,
  jobId: string,
  owner: string,
  partId: string,
  deps: EvaluatorDeps,
): Promise<JobOutcome> {
  const part = getBatchPart(db, partId);
  if (!part || part.state !== "pending") {
    // 已有终态：幂等完成，不重复展开或重复生成任务。
    return { persisted: false, result: null, matched: 0, gated: true };
  }
  const members = listProcessingByPart(db, partId);
  const run = getEvaluationRun(db, part.runId);
  const needs = needsForRun(db, run);

  const commitExpand = (input: {
    reason: string | null;
    gateRequestId: string | null;
    gateResult: ChoiceOutcome | null;
  }): JobOutcome => {
    const nowIso = nowFrom(deps).toISOString();
    const commit = db.transaction((): boolean => {
      if (!isJobOwnedBy(db, jobId, owner)) return false;
      const changed = expandBatchPart(db, {
        partId,
        gateRequestId: input.gateRequestId,
        gateResult: input.gateResult,
        fallbackReason: input.reason,
        now: nowIso,
      });
      if (!changed) return false;
      // 幂等展开：evaluate:<id> 唯一键保证重复执行不重复生成任务。
      for (const member of members) {
        enqueueJob(db, {
          kind: "evaluate",
          payloadKey: `evaluate:${member.bulletinId}`,
          payload: {
            bulletinId: member.bulletinId,
            evaluationRunId: run?.id ?? null,
          },
          runAt: nowIso,
        });
      }
      completeJob(db, jobId, owner);
      return true;
    });
    const persisted = commit.immediate();
    return { persisted, result: null, matched: 0, gated: true };
  };

  if (members.length === 0) {
    return { persisted: false, result: null, matched: 0, gated: true };
  }

  const bulletins = members
    .map((member) => getBulletin(db, member.bulletinId))
    .filter((bulletin): bulletin is Bulletin => bulletin !== null);
  if (bulletins.length !== members.length) {
    return commitExpand({
      reason: "批次成员缺失，已转逐条判断",
      gateRequestId: part.gateRequestId,
      gateResult: null,
    });
  }
  if (bulletins.length <= 1) {
    // 单成员子批不应创建门控；防御性转逐条，避免无意义额外调用。
    return commitExpand({
      reason: "单成员子批直接逐条判断",
      gateRequestId: part.gateRequestId,
      gateResult: null,
    });
  }
  if (needs.length === 0) {
    return commitExpand({
      reason: "当前没有启用需求，未调用模型",
      gateRequestId: part.gateRequestId,
      gateResult: null,
    });
  }

  const gateMembers = bulletins.map(bulletinToMember);
  if (
    measureBatchGateBytes(gateMembers, needs, getJevConfig(db).model) >
    MAX_BATCH_GATE_BYTES
  ) {
    // 服务配置变化导致体积重新超限：全成员逐条回退，不在请求体里偷偷删数据。
    return commitExpand({
      reason: "门控请求超过体积上限，已转逐条判断",
      gateRequestId: part.gateRequestId,
      gateResult: null,
    });
  }

  const { state, questions } = buildBatchGateRequest(gateMembers, needs);
  const outcome = await callJevWithLedger(
    db,
    {
      purpose: "batch_gate",
      state,
      questions,
      jobId,
      jobOwner: owner,
      evaluationRunId: run?.id ?? null,
      batchPartId: partId,
      // 受信服务端的业务校验：不合法按一次实际失败落账并回退逐条。
      validateResponse: (response) => {
        const parsed = parseBatchGateResponse(response);
        return parsed.result === "failed"
          ? { ok: false as const, error: parsed.error ?? "门控答案不合法" }
          : { ok: true as const };
      },
    },
    deps,
  );

  if (outcome.status === "blocked") {
    throw new JevCallBlockedError(outcome.block);
  }
  if (outcome.status === "failed") {
    // 实际请求失败/非法答案：记录原因并展开全成员逐条（429/529 仍服从共享退避）。
    return commitExpand({
      reason: `批次初筛失败，已转逐条判断：${outcome.error.message}`,
      gateRequestId: outcome.requestId,
      gateResult: null,
    });
  }

  const parsed = parseBatchGateResponse(outcome.response);
  if (parsed.result === "failed") {
    return commitExpand({
      reason: `批次初筛结果不合法，已转逐条判断：${parsed.error ?? "未知原因"}`,
      gateRequestId: outcome.requestId,
      gateResult: null,
    });
  }

  const currentConfig = getJevConfig(db);
  const semanticChanged =
    normalizeBaseUrl(currentConfig.baseUrl) !== outcome.semanticConfig.baseUrl ||
    currentConfig.model !== outcome.semanticConfig.model;

  if (parsed.result === "not_matched" && !semanticChanged) {
    // 合法且明确的「全批对全部需求均不相关」才允许整批结束。
    const nowIso = nowFrom(deps).toISOString();
    const commit = db.transaction((): boolean => {
      if (!isJobOwnedBy(db, jobId, owner)) return false;
      const changed = excludeBatchPart(db, {
        partId,
        gateRequestId: outcome.requestId,
        gateResult: "not_matched",
        reason: BATCH_EXCLUDED_REASON,
        now: nowIso,
      });
      if (!changed) return false;
      completeJob(db, jobId, owner);
      return true;
    });
    const persisted = commit.immediate();
    return {
      persisted,
      result: null,
      matched: 0,
      filtered: true,
      filteredCount: members.length,
      gated: true,
    };
  }

  // matched / uncertain：展开全部成员（不只处理点名条目）；
  // 连接语义变化时否定结果不作数，改为逐条。
  return commitExpand({
    reason: semanticChanged
      ? "门控期间服务地址或模型发生变化，否定结果不作为最终结论，已转逐条判断"
      : null,
    gateRequestId: outcome.requestId,
    gateResult: parsed.result,
  });
}

export async function runEvaluatorOnce(
  db: Database.Database,
  _env: AppEnv,
  deps: EvaluatorDeps = {},
): Promise<EvaluatorRoundResult> {
  const now = nowFrom(deps);
  const stats: EvaluatorRoundResult = {
    processed: 0,
    matched: 0,
    uncertain: 0,
    failed: 0,
    deferred: 0,
    gated: 0,
    filtered: 0,
  };
  const errors: string[] = [];

  // 每轮重新读取调度设置，网页改完立即生效，无需重启 worker。
  const config = getJevConfig(db);

  // 超期请求预留转为 interrupted：释放容量、费用未知，迟到真实结果仍可补写一次。
  reclaimExpiredRequestReservations(db, now);

  // 租约必须覆盖请求超时 + 收尾余量；预筛实际耗时会由统一服务按实际 timeout 校准。
  const leaseMs = config.timeoutMs + JOB_LEASE_MARGIN_MS;

  /** 处理实际失败 / 未发送阻塞：使用处理当时的时钟重排。 */
  const handleJobError = (jobId: string, owner: string, error: unknown): void => {
    const errorNow = nowFrom(deps);
    if (error instanceof JevCallBlockedError) {
      // 没有发出上游请求：配置类问题保持永久可恢复（只累计 attempts 供观察），
      // 容量/退避/失租只短暂延后，都不计入线报本身失败。
      if (error.isConfigProblem) {
        failJob(db, jobId, error.message, errorNow, {
          permanentRetry: true,
          owner,
        });
      } else {
        const delayMs = error.retryAfterMs ?? JOB_BUSY_RETRY_MS;
        requeueJob(
          db,
          jobId,
          owner,
          error.message,
          new Date(errorNow.getTime() + delayMs),
          errorNow,
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
    failJob(db, jobId, message, errorNow, { owner });
    errors.push(`判断失败：${message}`);
    stats.failed += 1;
  };

  /** 处理一个已领取的任务（含解析、跳过基线与失败分类）。 */
  const processJob = async (jobId: string, owner: string): Promise<void> => {
    const job = getJob(db, jobId);
    if (!job) return;
    let payload: JobPayload;
    try {
      payload = JSON.parse(job.payload) as JobPayload;
    } catch {
      completeJob(db, jobId, owner);
      return;
    }

    if (job.kind === "screen_batch") {
      if (!payload.partId) {
        completeJob(db, jobId, owner);
        return;
      }
      try {
        const outcome = await screenBatchJob(db, jobId, owner, payload.partId, deps);
        completeJob(db, jobId, owner);
        if (!outcome.persisted) return;
        stats.processed += 1;
        stats.gated += 1;
        if (outcome.filtered) stats.filtered += outcome.filteredCount ?? 1;
      } catch (error) {
        handleJobError(jobId, owner, error);
      }
      return;
    }

    if (!payload.bulletinId) {
      completeJob(db, jobId, owner);
      return;
    }
    const bulletin = getBulletin(db, payload.bulletinId);
    if (!bulletin || bulletin.baseline) {
      completeJob(db, jobId, owner);
      return;
    }

    try {
      const outcome = await evaluateJob(
        db,
        jobId,
        owner,
        payload.bulletinId,
        payload.evaluationRunId,
        deps,
      );
      completeJob(db, jobId, owner);
      if (!outcome.persisted) return;
      stats.processed += 1;
      stats.matched += outcome.matched;
      if (outcome.filtered) {
        stats.filtered += outcome.filteredCount ?? 1;
        return;
      }
      if (outcome.result === "uncertain") stats.uncertain += 1;
      if (outcome.result === "failed") stats.failed += 1;
    } catch (error) {
      handleJobError(jobId, owner, error);
    }
  };

  // 按执行槽领取：每个槽处理完一个任务才领下一个，队列中的任务不占用租约。
  // evaluate 与 screen_batch 共用同一 jobsPerRound 与执行槽，不分别翻倍预算。
  let processedSlots = 0;
  const laneCount = Math.max(1, Math.min(config.concurrency, config.jobsPerRound));
  await Promise.all(
    Array.from({ length: laneCount }, async () => {
      for (;;) {
        // 检查与自增之间没有 await，多个执行槽不会超领。
        if (processedSlots >= config.jobsPerRound) break;
        // 每次 claim 使用当前时钟，不用轮开始时的时间。
        const claimNow = nowFrom(deps);
        const job = claimJob(db, `evaluator:${randomUUID()}`, leaseMs, claimNow, [
          "evaluate",
          "screen_batch",
        ]);
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
