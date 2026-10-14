import type Database from "better-sqlite3";
import { listEnabledNeeds } from "@/lib/db/repos/needs";
import { callSystemOne, JevError } from "@/lib/jev/client";
import {
  buildQuestions,
  buildStateFromFields,
  parseAnswers,
  type StateFields,
} from "@/lib/jev/prompt";
import { getJevConfigView, getJevRuntimeConfig } from "@/lib/service/config";
import { RULE_VERSION } from "@/lib/domain/constants";
import type { ChoiceOutcome } from "@/lib/domain/types";

/**
 * 需求试判（dry-run）——仅用于验收。
 *
 * 复用与生产完全相同的 questions 构造与答案解析，调真实 Jev，但：
 * - **不写** evaluations / notifications / deliveries；
 * - 不影响采集、基线、任务队列与投递状态；
 * - 不修改任何配置。
 *
 * 由于真实线报只能被动等待，这个入口用于立即验证语义正反例（AC5/AC6）。
 */

export interface DryRunInput extends StateFields {
  title: string;
}

export interface DryRunNeedResult {
  needId: string;
  needName: string;
  needNote: string;
  needVersion: number;
  result: ChoiceOutcome | "failed";
  probabilities: Record<string, number> | null;
  confidence: number | null;
  error: string | null;
}

export interface DryRunResult {
  configVersion: number;
  model: string;
  ruleVersion: string;
  needsCount: number;
  results: DryRunNeedResult[];
}

export interface DryRunDependencies {
  callSystemOne?: typeof callSystemOne;
  fetchImpl?: typeof fetch;
}

export async function runJevDryRun(
  db: Database.Database,
  input: DryRunInput,
  deps: DryRunDependencies = {},
): Promise<DryRunResult> {
  const needs = listEnabledNeeds(db);
  const configVersion = getJevConfigView(db).version;

  if (needs.length === 0) {
    return {
      configVersion,
      model: "",
      ruleVersion: RULE_VERSION,
      needsCount: 0,
      results: [],
    };
  }

  const runtime = getJevRuntimeConfig(db);
  if (!runtime) {
    throw new JevError("Jev 未配置 API 密钥，请先在页面保存配置", {
      retryable: true,
      code: "not_configured",
    });
  }

  const { questions, needByQuestionId } = buildQuestions(needs);
  const state = buildStateFromFields({
    title: input.title,
    content: input.content ?? null,
    category: input.category ?? null,
    brand: input.brand ?? null,
    mall: input.mall ?? null,
    price: input.price ?? null,
  });

  const call = deps.callSystemOne ?? callSystemOne;
  const response = await call(
    {
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      model: runtime.model,
      timeoutMs: runtime.timeoutMs,
    },
    { state, model: runtime.model, questions },
    deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
  );

  const questionIds = Object.keys(questions);
  const answers = parseAnswers(response, questionIds);

  const results: DryRunNeedResult[] = [];
  for (const questionId of questionIds) {
    const need = needByQuestionId.get(questionId);
    if (!need) continue;
    const answer = answers[questionId];
    results.push({
      needId: need.id,
      needName: need.name,
      needNote: need.note,
      needVersion: need.version,
      result: answer.result,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      error: answer.error,
    });
  }

  return {
    configVersion,
    model: runtime.model,
    ruleVersion: RULE_VERSION,
    needsCount: needs.length,
    results,
  };
}
