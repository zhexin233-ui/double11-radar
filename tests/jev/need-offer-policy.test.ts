import { describe, expect, it } from "vitest";
import { parseAnswer } from "@/lib/jev/prompt";
import {
  decideNeedOfferConfirmation,
  NEED_OFFER_CONFIRMATION_POLICY,
} from "@/lib/jev/match-policy";
import type { EvaluationResult } from "@/lib/domain/types";

function answer(result: EvaluationResult) {
  if (result === "failed") return parseAnswer(undefined);
  return parseAnswer({ type: "choice", choice: result, probabilities: {
    matched: result === "matched" ? 0.69 : 0.1,
    not_matched: result === "not_matched" ? 0.8 : result === "matched" ? 0.21 : 0.1,
    uncertain: result === "uncertain" ? 0.8 : 0.1,
  } });
}

// 人工期望矩阵：行=相关性、列=该需求促销，优先级是契约而非从实现动态生成。
const matrix = [
  ["matched", "matched", "matched", "need_and_offer_confirmed"],
  ["matched", "not_matched", "not_matched", "offer_not_matched"],
  ["matched", "uncertain", "uncertain", "offer_uncertain"],
  ["matched", "failed", "failed", "offer_parse_failed"],
  ["not_matched", "matched", "not_matched", "relevance_not_matched"],
  ["not_matched", "not_matched", "not_matched", "relevance_not_matched"],
  ["not_matched", "uncertain", "not_matched", "relevance_not_matched"],
  ["not_matched", "failed", "failed", "offer_parse_failed"],
  ["uncertain", "matched", "uncertain", "relevance_uncertain"],
  ["uncertain", "not_matched", "not_matched", "offer_not_matched"],
  ["uncertain", "uncertain", "uncertain", "relevance_uncertain"],
  ["uncertain", "failed", "failed", "offer_parse_failed"],
  ["failed", "matched", "failed", "relevance_parse_failed"],
  ["failed", "not_matched", "failed", "relevance_parse_failed"],
  ["failed", "uncertain", "failed", "relevance_parse_failed"],
  ["failed", "failed", "failed", "relevance_parse_failed"],
] as const;

describe("双项确认纯决策（离线规则证据，不代表模型语义质量）", () => {
  it.each(matrix)("相关性 %s / 促销 %s → %s（%s）", (relevance, offer, result, reason) => {
    const decision = decideNeedOfferConfirmation(answer(relevance), answer(offer));
    expect(decision).toMatchObject({ result, reason, modelResult: relevance === "failed" ? null : relevance });
    if (result === "failed") expect(decision.error).toBeTruthy();
    else expect(decision.error).toBeNull();
  });

  it.each([0.69, 0.76, 0.5])("有效双 matched p=%s 不受旧0.80拦截，置信度不参与", (matched) => {
    const original = parseAnswer({ choice: "matched", probabilities: { matched, not_matched: 1 - matched, uncertain: 0 }, confidence: -5 });
    expect(decideNeedOfferConfirmation(original, original).result).toBe("matched");
    expect(original.confidence).toBe(-5);
    expect(NEED_OFFER_CONFIRMATION_POLICY.relevance.minMatchedProbability).toBeNull();
    expect(Object.isFrozen(NEED_OFFER_CONFIRMATION_POLICY.offer)).toBe(true);
  });

  const invalid = [
    [null, "probabilities_missing"],
    [{ matched: 1 }, "probabilities_invalid"],
    [{ matched: 0.8, not_matched: 0.1, uncertain: 0.1, extra: 0 }, "probabilities_invalid"],
    [{ matched: 1.1, not_matched: -0.1, uncertain: 0 }, "probabilities_invalid"],
    [{ matched: 0.7, not_matched: 0.1, uncertain: 0.1 }, "probabilities_invalid"],
    [{ matched: Number.NaN, not_matched: 0, uncertain: 0 }, "probabilities_invalid"],
    [{ matched: 0.3, not_matched: 0.5, uncertain: 0.2 }, "choice_probability_conflict"],
  ] as const;
  for (const dimension of ["relevance", "offer"] as const) {
    it.each(invalid)(`${dimension} matched 的异常分布 %j → %s`, (probabilities, suffix) => {
      const invalidAnswer = { ...answer("matched"), probabilities };
      const decision = dimension === "relevance"
        ? decideNeedOfferConfirmation(invalidAnswer, answer("matched"))
        : decideNeedOfferConfirmation(answer("matched"), invalidAnswer);
      expect(decision).toMatchObject({ result: "uncertain", reason: `${dimension}_${suffix}`, error: null });
      expect(invalidAnswer.probabilities).toBe(probabilities);
    });
  }
  it("先保留明确否定或 uncertain，仅双 matched 时校验业务分布", () => {
    const noDistribution = { ...answer("matched"), probabilities: null };
    expect(decideNeedOfferConfirmation(noDistribution, answer("not_matched")).reason).toBe("offer_not_matched");
    expect(decideNeedOfferConfirmation(answer("uncertain"), noDistribution).reason).toBe("relevance_uncertain");
    expect(decideNeedOfferConfirmation(noDistribution, noDistribution).reason).toBe("relevance_probabilities_missing");
  });
  it.each([undefined, null, { type: "score", choice: "matched" }, { choice: "maybe" }, { choice: "matched", probabilities: { matched: "high" } }])("促销缺题或基础类型错误 %j 必须 failed", (raw) => {
    expect(decideNeedOfferConfirmation(answer("not_matched"), parseAnswer(raw))).toMatchObject({ result: "failed", reason: "offer_parse_failed", modelResult: "not_matched" });
  });
  it("分布总和容差边界与并列最高通过，超界不自动归一化", () => {
    const boundary = { ...answer("matched"), probabilities: { matched: 0.5, not_matched: 0.5, uncertain: 0.01 } };
    expect(decideNeedOfferConfirmation(boundary, answer("matched")).result).toBe("matched");
    const above = { ...boundary, probabilities: { ...boundary.probabilities, uncertain: 0.010001 } };
    expect(decideNeedOfferConfirmation(above, answer("matched")).reason).toBe("relevance_probabilities_invalid");
  });
});
