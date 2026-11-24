import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getBulletin } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import {
  claimJob,
  completeJob,
  failJob,
  isJobOwnedBy,
} from "@/lib/db/repos/jobs";
import { listNeeds } from "@/lib/db/repos/needs";
import { upsertBulletinAnalysis } from "@/lib/db/repos/analyses";
import { RULE_VERSION } from "@/lib/domain/constants";
import type {
  AnalysisTriggerSource,
  Bulletin,
  BulletinAnalysis,
  Evaluation,
  Need,
} from "@/lib/domain/types";
import type { AppEnv } from "@/lib/env";
import { Stage2LlmError } from "@/lib/agent/llm-client";
import { runStage2AgentLoop } from "@/lib/agent/loop";
import { buildRunnableTools } from "@/lib/agent/tools/registry";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import {
  getStage2Config,
  readStage2LlmApiKey,
} from "@/lib/service/stage2-config";
import { createStage2LoopCaller } from "@/lib/service/stage2-requests";

export const STAGE2_FALLBACK_NOTE =
  "二级核验未完成，以下为一级命中原文，请人工核对";

interface AnalyzeJobPayload {
  bulletinId: string;
  triggerSource?: AnalysisTriggerSource;
  needIds?: string[];
}

export interface AnalyzerDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  encryptionKey?: Buffer;
}

function resolveMatchedNeedsAndEvaluations(
  db: Database.Database,
  bulletinId: string,
  triggerSource: AnalysisTriggerSource,
  needIds?: string[],
): {
  needs: Array<Pick<Need, "id" | "name" | "note">>;
  evaluations: Evaluation[];
} {
  const allEvals = listEvaluationsByBulletin(db, bulletinId);
  const needIdSet =
    Array.isArray(needIds) && needIds.length > 0 ? new Set(needIds) : null;

  const targetResult = triggerSource === "uncertain" ? "uncertain" : "matched";
  let selectedEvals = allEvals.filter(
    (e) =>
      e.ruleVersion === RULE_VERSION &&
      (triggerSource === "manual"
        ? e.result === "matched" || e.result === "uncertain"
        : e.result === targetResult) &&
      (!needIdSet || needIdSet.has(e.needId)),
  );

  if (selectedEvals.length === 0 && triggerSource === "manual") {
    selectedEvals = allEvals.filter((e) => e.result === "matched");
  }

  if (selectedEvals.length > 0) {
    return {
      needs: selectedEvals.map((e) => ({
        id: e.needId,
        name: e.needName,
        note: e.needNote,
      })),
      evaluations: selectedEvals,
    };
  }

  const enabledNeeds = listNeeds(db).filter((n) => n.enabled);
  return {
    needs: enabledNeeds.map((n) => ({
      id: n.id,
      name: n.name,
      note: n.note,
    })),
    evaluations: [],
  };
}

/**
 * 对单条线报立即执行一次第二级深度核验并落库（供手动触发接口复用）。
 * 不自动重发历史已存在通知。
 */
export async function analyzeBulletinOnce(
  db: Database.Database,
  bulletin: Bulletin,
  options: AnalyzerDeps & {
    triggerSource?: AnalysisTriggerSource;
    needIds?: string[];
  } = {},
): Promise<BulletinAnalysis> {
  const now = options.now ? options.now() : new Date();
  const { config, version } = getStage2Config(db, options.encryptionKey);
  const { apiKey, unreadable } = readStage2LlmApiKey(
    db,
    options.encryptionKey,
  );

  if (unreadable || !apiKey) {
    throw new Stage2LlmError(
      "auth",
      unreadable
        ? "二级 LLM 密钥无法解密，请重新配置"
        : "尚未配置二级 LLM API 密钥",
      { retryable: false },
    );
  }

  const triggerSource = options.triggerSource ?? "manual";
  const { needs } = resolveMatchedNeedsAndEvaluations(
    db,
    bulletin.id,
    triggerSource,
    options.needIds,
  );

  const tools = buildRunnableTools(db, {
    currentBulletinId: bulletin.id,
    now,
    encryptionKey: options.encryptionKey,
    fetchImpl: options.fetchImpl,
  });

  const callLlm = createStage2LoopCaller(db, {
    purpose: triggerSource === "manual" ? "manual_analyze" : "analyze",
    bulletinId: bulletin.id,
    jobId: null,
    configVersion: version,
    manualInputUsdPerMillion: config.llm.inputUsdPerMillion,
    manualOutputUsdPerMillion: config.llm.outputUsdPerMillion,
    openRouterModelId: config.llm.openRouterModelId,
    now: options.now,
  });

  const loopRes = await runStage2AgentLoop({
    bulletin,
    matchedNeeds: needs,
    tools,
    llm: {
      baseUrl: config.llm.baseUrl,
      apiKey,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      maxSteps: config.llm.maxSteps,
      temperature: config.llm.temperature,
    },
    callLlm,
    fetchImpl: options.fetchImpl,
  });

  return upsertBulletinAnalysis(
    db,
    {
      bulletinId: bulletin.id,
      triggerSource,
      status: loopRes.status,
      verdict: loopRes.answer?.verdict ?? null,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      activeToolIds: loopRes.activeToolIds,
      stepsUsed: loopRes.stepsUsed,
      toolCallsCount: loopRes.toolTrace.length,
      inputTokens: loopRes.inputTokens,
      outputTokens: loopRes.outputTokens,
      durationMs: loopRes.durationMs,
      answer: loopRes.answer,
      toolTrace: loopRes.toolTrace,
      error: loopRes.error,
      fallbackNotified: false,
    },
    options.now ? options.now() : new Date(),
  );
}

export async function runAnalyzerOnce(
  db: Database.Database,
  _env?: AppEnv,
  deps: AnalyzerDeps = {},
): Promise<{ processed: number }> {
  const { config, version } = getStage2Config(db, deps.encryptionKey);
  const leaseMs =
    config.llm.timeoutMs * Math.min(config.llm.maxSteps + 1, 8) + 30_000;
  const owner = `analyzer-${randomUUID()}`;
  const nowFn = deps.now ?? (() => new Date());

  const claimedJobs = [];
  for (let i = 0; i < config.concurrency; i++) {
    const job = claimJob(db, owner, leaseMs, nowFn(), "analyze");
    if (!job) break;
    claimedJobs.push(job);
  }

  if (claimedJobs.length === 0) {
    return { processed: 0 };
  }

  await Promise.all(
    claimedJobs.map(async (job) => {
      let payload: AnalyzeJobPayload;
      try {
        payload = JSON.parse(job.payload) as AnalyzeJobPayload;
      } catch {
        completeJob(db, job.id, owner);
        return;
      }

      const bulletin = getBulletin(db, payload.bulletinId);
      if (!bulletin) {
        completeJob(db, job.id, owner);
        return;
      }

      const triggerSource: AnalysisTriggerSource =
        payload.triggerSource ?? "matched";
      const { apiKey, unreadable } = readStage2LlmApiKey(
        db,
        deps.encryptionKey,
      );

      if (unreadable || !apiKey) {
        failJob(
          db,
          job.id,
          unreadable
            ? "二级 LLM 密钥无法解密，请重新配置"
            : "尚未配置二级 LLM API 密钥",
          nowFn(),
          { permanentRetry: true, owner },
        );
        return;
      }

      const { needs, evaluations } = resolveMatchedNeedsAndEvaluations(
        db,
        bulletin.id,
        triggerSource,
        payload.needIds,
      );

      const tools = buildRunnableTools(db, {
        currentBulletinId: bulletin.id,
        now: nowFn(),
        encryptionKey: deps.encryptionKey,
        fetchImpl: deps.fetchImpl,
      });

      const handleTerminalFailure = (errorMessage: string) => {
        const failRes = failJob(db, job.id, errorMessage, nowFn(), { owner });
        if (
          failRes.status === "dead" &&
          triggerSource === "matched" &&
          config.fallbackToStage1Notify &&
          evaluations.length > 0
        ) {
          const fallbackTx = db.transaction(() => {
            upsertBulletinAnalysis(
              db,
              {
                bulletinId: bulletin.id,
                triggerSource,
                status: "failed",
                verdict: null,
                model: config.llm.model,
                baseUrl: config.llm.baseUrl,
                activeToolIds: tools.map((t) => t.pluginId),
                stepsUsed: 0,
                toolCallsCount: 0,
                inputTokens: null,
                outputTokens: null,
                durationMs: 0,
                answer: null,
                toolTrace: [],
                error: errorMessage,
                fallbackNotified: true,
              },
              nowFn(),
            );
            createNotificationAndDeliveries(
              db,
              bulletin,
              evaluations,
              deps.encryptionKey,
              { analysisFallbackNote: STAGE2_FALLBACK_NOTE },
            );
          });
          fallbackTx.immediate();
        }
      };

      try {
        const callLlm = createStage2LoopCaller(db, {
          purpose: "analyze",
          bulletinId: bulletin.id,
          jobId: job.id,
          configVersion: version,
          manualInputUsdPerMillion: config.llm.inputUsdPerMillion,
          manualOutputUsdPerMillion: config.llm.outputUsdPerMillion,
          openRouterModelId: config.llm.openRouterModelId,
          now: deps.now,
        });

        const loopRes = await runStage2AgentLoop({
          bulletin,
          matchedNeeds: needs,
          tools,
          llm: {
            baseUrl: config.llm.baseUrl,
            apiKey,
            model: config.llm.model,
            timeoutMs: config.llm.timeoutMs,
            maxSteps: config.llm.maxSteps,
            temperature: config.llm.temperature,
          },
          callLlm,
          fetchImpl: deps.fetchImpl,
        });

        if (loopRes.status === "failed" || !loopRes.answer) {
          const errMsg = loopRes.error ?? "二级核验输出未通过 Schema 校验";
          const failRes = failJob(db, job.id, errMsg, nowFn(), { owner });
          if (failRes.status === "dead") {
            const deadTx = db.transaction(() => {
              const shouldFallback =
                triggerSource === "matched" &&
                config.fallbackToStage1Notify &&
                evaluations.length > 0;
              upsertBulletinAnalysis(
                db,
                {
                  bulletinId: bulletin.id,
                  triggerSource,
                  status: "failed",
                  verdict: null,
                  model: config.llm.model,
                  baseUrl: config.llm.baseUrl,
                  activeToolIds: loopRes.activeToolIds,
                  stepsUsed: loopRes.stepsUsed,
                  toolCallsCount: loopRes.toolTrace.length,
                  inputTokens: loopRes.inputTokens,
                  outputTokens: loopRes.outputTokens,
                  durationMs: loopRes.durationMs,
                  answer: null,
                  toolTrace: loopRes.toolTrace,
                  error: errMsg,
                  fallbackNotified: shouldFallback,
                },
                nowFn(),
              );
              if (shouldFallback) {
                createNotificationAndDeliveries(
                  db,
                  bulletin,
                  evaluations,
                  deps.encryptionKey,
                  { analysisFallbackNote: STAGE2_FALLBACK_NOTE },
                );
              }
            });
            deadTx.immediate();
          }
          return;
        }

        const answer = loopRes.answer;
        const persistTx = db.transaction(() => {
          if (!isJobOwnedBy(db, job.id, owner)) return;

          upsertBulletinAnalysis(
            db,
            {
              bulletinId: bulletin.id,
              triggerSource,
              status: "succeeded",
              verdict: answer.verdict,
              model: config.llm.model,
              baseUrl: config.llm.baseUrl,
              activeToolIds: loopRes.activeToolIds,
              stepsUsed: loopRes.stepsUsed,
              toolCallsCount: loopRes.toolTrace.length,
              inputTokens: loopRes.inputTokens,
              outputTokens: loopRes.outputTokens,
              durationMs: loopRes.durationMs,
              answer,
              toolTrace: loopRes.toolTrace,
              error: null,
              fallbackNotified: false,
            },
            nowFn(),
          );

          const shouldNotify =
            answer.verdict === "recommended" ||
            answer.verdict === "acceptable" ||
            (answer.verdict === "insufficient_info" &&
              config.notifyOnInsufficientInfo);

          if (shouldNotify && evaluations.length > 0) {
            createNotificationAndDeliveries(
              db,
              bulletin,
              evaluations,
              deps.encryptionKey,
              { analysis: answer },
            );
          }

          completeJob(db, job.id, owner);
        });
        persistTx.immediate();
      } catch (err) {
        if (err instanceof Stage2LlmError && err.kind === "auth") {
          failJob(db, job.id, err.message, nowFn(), {
            permanentRetry: true,
            owner,
          });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        handleTerminalFailure(msg);
      }
    }),
  );

  return { processed: claimedJobs.length };
}
