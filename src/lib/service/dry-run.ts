import type Database from "better-sqlite3";
import { listEnabledNeeds } from "@/lib/db/repos/needs";
import { callSystemOne } from "@/lib/jev/client";
import {
  buildQuestions,
  buildStateFromFields,
  parseAnswers,
  type StateFields,
} from "@/lib/jev/prompt";
import { getJevConfigView } from "@/lib/service/config";
import {
  JevCallBlockedError,
  callJevWithLedger,
} from "@/lib/service/jev-requests";
import { RULE_VERSION } from "@/lib/domain/constants";
import type { ChoiceOutcome } from "@/lib/domain/types";

/**
 * 需求试判（dry-run）——仅用于验收。
 *
 * 复用与生产完全相同的 questions 构造、统一请求服务与答案解析，调真实 Jev，但：
 * - **不写** evaluations / notifications / deliveries / jobs；
 * - 不影响采集、基线、任务队列与投递状态；
 * - 不修改任何配置。
 *
 * 本期新增的唯一副作用是调用账本（`jev_requests`）：试判同样是实际付费调用，
 * 必须进入费用统计，否则统计会低估真实用量。
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
  now?: () => Date;
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

  const { questions, needByQuestionId } = buildQuestions(needs);
  const state = buildStateFromFields({
    title: input.title,
    content: input.content ?? null,
    category: input.category ?? null,
    brand: input.brand ?? null,
    mall: input.mall ?? null,
    price: input.price ?? null,
  });

  // 与生产判断共用统一服务：容量、Key 选择、失败计数与用量账本行为完全一致。
  const outcome = await callJevWithLedger(
    db,
    { purpose: "dry_run", state, questions },
    {
      ...(deps.callSystemOne ? { callSystemOne: deps.callSystemOne } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );

  // 没有发出上游请求的阻塞（容量满/退避/无可用 Key）要明确报错，不能静默返回空结果。
  if (outcome.status === "blocked") throw new JevCallBlockedError(outcome.block);
  if (outcome.status === "failed") throw outcome.error;

  const questionIds = Object.keys(questions);
  const answers = parseAnswers(outcome.response, questionIds);

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
    model: outcome.response.model ?? "",
    ruleVersion: RULE_VERSION,
    needsCount: needs.length,
    results,
  };
}
