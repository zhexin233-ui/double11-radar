import type Database from "better-sqlite3";
import {
  callOpenAiChatCompletion,
  sanitizeStage2LedgerError,
  Stage2LlmError,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from "@/lib/agent/llm-client";
import {
  completeStage2Request,
  insertInFlightStage2Request,
  type Stage2PricingSnapshotContext,
} from "@/lib/db/repos/stage2-requests";
import type { Stage2Request, Stage2RequestPurpose } from "@/lib/domain/types";
import { providerOriginFromBaseUrl } from "@/lib/jev/pricing";
import { getOpenRouterCatalogSnapshot } from "@/lib/service/openrouter-pricing";

/** 单次二级请求预留租约在 timeoutMs 之外的安全缓冲（30 秒）。 */
export const STAGE2_REQUEST_LEASE_BUFFER_MS = 30_000;

export interface Stage2LedgerCallInput {
  purpose: Stage2RequestPurpose;
  bulletinId?: string | null;
  jobId?: string | null;
  configVersion: number | null;
  manualInputUsdPerMillion: number | null;
  manualOutputUsdPerMillion: number | null;
  openRouterModelId: string | null;
  request: ChatCompletionRequest;
  now?: () => Date;
}

export interface Stage2LedgerCallResult {
  response: ChatCompletionResponse;
  requestId: string;
  ledger: Stage2Request | null;
}

/**
 * 统一的二级 LLM 调用计费封装。
 *
 * - 上游请求前在账本中预留 `in_flight`（租约 = `timeoutMs + 30s`），并绑定当时的配置与目录快照；
 * - 网络请求在事务外执行；
 * - 成功或失败均原子更新同一行（失败错误经白名单分类，绝不落库上游原始正文与密钥）。
 */
export async function callStage2LlmWithLedger(
  db: Database.Database,
  input: Stage2LedgerCallInput,
): Promise<Stage2LedgerCallResult> {
  const nowFn = input.now ?? (() => new Date());
  const startedAt = nowFn();
  const leaseUntil = new Date(
    startedAt.getTime() +
      input.request.timeoutMs +
      STAGE2_REQUEST_LEASE_BUFFER_MS,
  );
  const providerOrigin = providerOriginFromBaseUrl(input.request.baseUrl);
  const catalogSnapshot = getOpenRouterCatalogSnapshot(db);

  const pricingContext: Stage2PricingSnapshotContext = {
    manualInputUsdPerMillion: input.manualInputUsdPerMillion,
    manualOutputUsdPerMillion: input.manualOutputUsdPerMillion,
    openRouterModelId: input.openRouterModelId,
    catalog: catalogSnapshot,
  };

  const reserved = insertInFlightStage2Request(db, {
    purpose: input.purpose,
    bulletinId: input.bulletinId ?? null,
    jobId: input.jobId ?? null,
    providerOrigin,
    configVersion: input.configVersion,
    requestedModel: input.request.model,
    startedAt,
    leaseUntil,
  });

  try {
    const response = await callOpenAiChatCompletion(input.request);
    const completed = completeStage2Request(db, {
      id: reserved.id,
      status: "succeeded",
      now: nowFn(),
      responseModel: response.responseModel,
      httpStatus: response.httpStatus,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      pricingContext,
    });
    return {
      response,
      requestId: reserved.id,
      ledger: completed.request,
    };
  } catch (err) {
    const safeErr = sanitizeStage2LedgerError(err);
    const meta =
      err instanceof Stage2LlmError
        ? {
            responseModel: err.responseModel,
            inputTokens: err.inputTokens,
            outputTokens: err.outputTokens,
          }
        : {
            responseModel: null,
            inputTokens: null,
            outputTokens: null,
          };

    completeStage2Request(db, {
      id: reserved.id,
      status: "failed",
      now: nowFn(),
      responseModel: meta.responseModel,
      httpStatus: safeErr.httpStatus,
      errorCode: safeErr.errorCode,
      errorMessage: safeErr.errorMessage,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      pricingContext,
    });

    throw err;
  }
}

export interface Stage2LoopCallerContext {
  purpose: Stage2RequestPurpose;
  bulletinId?: string | null;
  jobId?: string | null;
  configVersion: number | null;
  manualInputUsdPerMillion: number | null;
  manualOutputUsdPerMillion: number | null;
  openRouterModelId: string | null;
  now?: () => Date;
}

/** 构造注入给 `runStage2AgentLoop` 的统一调用器。 */
export function createStage2LoopCaller(
  db: Database.Database,
  context: Stage2LoopCallerContext,
): (req: ChatCompletionRequest) => Promise<ChatCompletionResponse> {
  return async (req: ChatCompletionRequest) => {
    const result = await callStage2LlmWithLedger(db, {
      ...context,
      request: req,
    });
    return result.response;
  };
}
