import type {
  ChoiceOutcome,
  DecisionReason,
  EvaluationResult,
  MatchConfirmationPolicy,
} from "@/lib/domain/types";
import type { ParsedAnswer } from "@/lib/jev/prompt";

/**
 * 可信度门控：把模型的原始三态选择转换为受确认门槛约束的业务结果。
 *
 * 设计要点（`design.md` 第 2 节）：
 * - 纯函数：不读环境变量、数据库或当前时间，自动判断与需求试判显式调用同一函数；
 * - 保留 `modelResult`（原始选择）与 `result`（业务结果）的区分，绝不改写原始概率/置信度；
 * - matched 只有在三态概率分布完整合法、且原始 p_matched ≥ 门槛时才确认为 matched，
 *   其余一律降为 uncertain 并带确定性原因码；
 * - `confidence` 只用于展示，不参与门槛：它来自分布集中程度，不能当作正确率。
 *
 * 业务降级不是失败：调用方落库时 `error` 保持 null、不重试、不增加 Key 失败计数。
 * 基础解析失败（缺答案 / 非法 choice / 概率类型错误）仍由 `prompt.ts` 判为 failed。
 */

/** 策略版本。任何算法或参数变化都必须提升版本并记录新快照。 */
export const MATCH_CONFIRMATION_POLICY_VERSION = "match-confirmation-v1";

/**
 * 初始策略快照（冻结，不可原地修改）。
 * 0.80 是保守的业务取舍，尚无真实总体校准；后续基于标注样本调整时需提升版本。
 */
export const MATCH_CONFIRMATION_POLICY: MatchConfirmationPolicy = Object.freeze({
  minMatchedProbability: 0.8,
  probabilitySumTolerance: 0.01,
});

/** 完整概率分布必须**恰好**包含这三个键。 */
const REQUIRED_PROBABILITY_KEYS: readonly ChoiceOutcome[] = [
  "matched",
  "not_matched",
  "uncertain",
];

/** 浮点累加误差容忍；与业务容差相加，避免恰好等于容差的合法分布被误判。 */
const SUM_EPSILON = 1e-12;

/**
 * 业务层分布校验：键恰好为 matched / not_matched / uncertain，每值有限且处于 [0,1]，
 * 且 |sum − 1| ≤ tolerance（含浮点误差）。不补缺项、不截断、不自动归一化。
 */
export function isCompleteProbabilityDistribution(
  probabilities: Record<string, number> | null,
  tolerance: number,
): boolean {
  if (!probabilities) return false;
  if (Object.keys(probabilities).length !== REQUIRED_PROBABILITY_KEYS.length) {
    return false;
  }
  let sum = 0;
  for (const key of REQUIRED_PROBABILITY_KEYS) {
    if (!Object.hasOwn(probabilities, key)) return false;
    const value = probabilities[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) return false;
    sum += value;
  }
  return Math.abs(sum - 1) <= tolerance + SUM_EPSILON;
}

export interface MatchDecision {
  /** 最终业务结果（persist 到 evaluations.result）。 */
  result: EvaluationResult;
  /** 模型原始三态；解析失败时为 null。 */
  modelResult: ChoiceOutcome | null;
  /** 确定性程序原因码。 */
  reason: DecisionReason;
}

/**
 * 单条需求的匹配确认决策（纯函数）。
 *
 * 处理顺序严格遵循 `design.md` 第 2.1 节：
 * parse_failed → 原 not_matched → 原 uncertain → matched 的缺失/非法分布 →
 * 选项冲突 → 低于门槛 → 确认匹配。
 */
export function decideMatchConfirmation(
  answer: ParsedAnswer,
  policy: MatchConfirmationPolicy = MATCH_CONFIRMATION_POLICY,
): MatchDecision {
  if (answer.result === "failed") {
    return { result: "failed", modelResult: null, reason: "parse_failed" };
  }

  const modelResult = answer.result;
  if (modelResult === "not_matched") {
    return { result: "not_matched", modelResult, reason: "model_not_matched" };
  }
  if (modelResult === "uncertain") {
    return { result: "uncertain", modelResult, reason: "model_uncertain" };
  }

  // 模型选择 matched：只有合格概率分布才参与门槛判断。
  const probabilities = answer.probabilities;
  if (!probabilities) {
    return { result: "uncertain", modelResult, reason: "probabilities_missing" };
  }
  if (
    !isCompleteProbabilityDistribution(
      probabilities,
      policy.probabilitySumTolerance,
    )
  ) {
    return { result: "uncertain", modelResult, reason: "probabilities_invalid" };
  }

  const matchedProbability = probabilities.matched;
  const strongestAlternative = Math.max(
    probabilities.not_matched,
    probabilities.uncertain,
  );
  // 严格小于才构成冲突；与最优选项并列仍继续走门槛检查。
  if (matchedProbability < strongestAlternative) {
    return {
      result: "uncertain",
      modelResult,
      reason: "choice_probability_conflict",
    };
  }
  // 直接比较原始值，不按显示小数四舍五入。
  if (matchedProbability < policy.minMatchedProbability) {
    return {
      result: "uncertain",
      modelResult,
      reason: "matched_probability_below_threshold",
    };
  }
  return { result: "matched", modelResult, reason: "matched_confirmed" };
}
