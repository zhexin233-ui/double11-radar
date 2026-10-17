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
import {
  MATCH_CONFIRMATION_POLICY,
  MATCH_CONFIRMATION_POLICY_VERSION,
  decideMatchConfirmation,
} from "@/lib/jev/match-policy";
import { RULE_VERSION } from "@/lib/domain/constants";
import type {
  ChoiceOutcome,
  DecisionReason,
  MatchConfirmationPolicy,
} from "@/lib/domain/types";

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
  /** 匹配确认后的业务结果；failed 只在基础解析失败时出现。 */
  result: ChoiceOutcome | "failed";
  /** 模型原始三态选择；解析失败时为 null。 */
  modelResult: ChoiceOutcome | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  decisionReason: DecisionReason;
  decisionPolicyVersion: string;
  decisionPolicy: MatchConfirmationPolicy;
  jevRequestId: string;
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
    // 与自动判断共用同一纯决策函数与策略快照，保证同输入结论一致。
    const decision = decideMatchConfirmation(answer, MATCH_CONFIRMATION_POLICY);
    results.push({
      needId: need.id,
      needName: need.name,
      needNote: need.note,
      needVersion: need.version,
      result: decision.result,
      modelResult: decision.modelResult,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      decisionReason: decision.reason,
      decisionPolicyVersion: MATCH_CONFIRMATION_POLICY_VERSION,
      decisionPolicy: MATCH_CONFIRMATION_POLICY,
      jevRequestId: outcome.requestId,
      error: answer.error,
    });
  }

  return {
    // 追溯实际预约的配置版本；仅在缺失（理论可空）时回退到请求前快照。
    configVersion: outcome.semanticConfig.configVersion ?? configVersion,
    model: outcome.response.model ?? "",
    ruleVersion: RULE_VERSION,
    needsCount: needs.length,
    results,
  };
}
