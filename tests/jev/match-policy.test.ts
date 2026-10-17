import { describe, expect, it } from "vitest";
import {
  MATCH_CONFIRMATION_POLICY,
  MATCH_CONFIRMATION_POLICY_VERSION,
  decideMatchConfirmation,
  isCompleteProbabilityDistribution,
} from "@/lib/jev/match-policy";
import { parseAnswer, type ParsedAnswer } from "@/lib/jev/prompt";

/**
 * 纯决策函数测试：验证算法边界，不代表业务效果校准。
 * 0.80 是保守取舍，样本来自人为构造与归档正例，不能当作准确率承诺。
 */

const POLICY = MATCH_CONFIRMATION_POLICY;

function answer(result: ParsedAnswer["result"], probabilities: Record<string, number> | null): ParsedAnswer {
  return { result, probabilities, confidence: 0.5, raw: "{}", error: null };
}

describe("概率分布业务校验", () => {
  it("恰好三键、各值在 [0,1]、总和在容差内才合法", () => {
    expect(
      isCompleteProbabilityDistribution(
        { matched: 0.8, not_matched: 0.1, uncertain: 0.1 },
        0.01,
      ),
    ).toBe(true);
    // 浮点误差与恰好等于容差都接受。
    expect(
      isCompleteProbabilityDistribution(
        { matched: 0.3333333, not_matched: 0.3333333, uncertain: 0.3333334 },
        0.01,
      ),
    ).toBe(true);
    expect(
      isCompleteProbabilityDistribution(
        { matched: 0.5, not_matched: 0.3, uncertain: 0.21 },
        0.01,
      ),
    ).toBe(true);
  });

  it("缺键 / 多键 / 越界 / 超容差 / 非有限一律不合法（不归一化）", () => {
    expect(
      isCompleteProbabilityDistribution({ matched: 1, not_matched: 0 }, 0.01),
    ).toBe(false);
    expect(
      isCompleteProbabilityDistribution(
        { matched: 0.5, not_matched: 0.3, uncertain: 0.1, extra: 0.1 },
        0.01,
      ),
    ).toBe(false);
    expect(
      isCompleteProbabilityDistribution(
        { matched: -0.1, not_matched: 0.6, uncertain: 0.5 },
        0.01,
      ),
    ).toBe(false);
    expect(
      isCompleteProbabilityDistribution(
        { matched: 1.1, not_matched: -0.1, uncertain: 0 },
        0.01,
      ),
    ).toBe(false);
    expect(
      isCompleteProbabilityDistribution(
        { matched: 0.5, not_matched: 0.3, uncertain: 0.2200001 },
        0.01,
      ),
    ).toBe(false);
    expect(
      isCompleteProbabilityDistribution(
        { matched: Number.NaN, not_matched: 0.5, uncertain: 0.5 },
        0.01,
      ),
    ).toBe(false);
    expect(isCompleteProbabilityDistribution(null, 0.01)).toBe(false);
  });
});

describe("匹配确认决策顺序", () => {
  it("基础解析失败保持 failed，且不伪称模型选择", () => {
    const parsed = parseAnswer({ type: "choice", choice: "maybe" });
    const decision = decideMatchConfirmation(parsed, POLICY);
    expect(decision.result).toBe("failed");
    expect(decision.modelResult).toBeNull();
    expect(decision.reason).toBe("parse_failed");
  });

  it("原 not_matched / uncertain 不被提升", () => {
    const notMatched = decideMatchConfirmation(answer("not_matched", null), POLICY);
    expect(notMatched).toEqual({
      result: "not_matched",
      modelResult: "not_matched",
      reason: "model_not_matched",
    });
    const uncertain = decideMatchConfirmation(answer("uncertain", null), POLICY);
    expect(uncertain).toEqual({
      result: "uncertain",
      modelResult: "uncertain",
      reason: "model_uncertain",
    });
  });

  it("用户案例 p=(.52,.15,.33) 降为待确认，原因低于门槛", () => {
    const decision = decideMatchConfirmation(
      answer("matched", { matched: 0.52, not_matched: 0.15, uncertain: 0.33 }),
      POLICY,
    );
    expect(decision.result).toBe("uncertain");
    expect(decision.modelResult).toBe("matched");
    expect(decision.reason).toBe("matched_probability_below_threshold");
  });

  it("缺概率降为待确认且不伪造分布", () => {
    const decision = decideMatchConfirmation(answer("matched", null), POLICY);
    expect(decision.result).toBe("uncertain");
    expect(decision.reason).toBe("probabilities_missing");
  });

  it("非法分布降为待确认（缺键/多键/负数/总和超差）", () => {
    expect(
      decideMatchConfirmation(answer("matched", { matched: 1 }), POLICY).reason,
    ).toBe("probabilities_invalid");
    expect(
      decideMatchConfirmation(
        answer("matched", { matched: 0.5, not_matched: 0.3, uncertain: 0.1, x: 0.1 }),
        POLICY,
      ).reason,
    ).toBe("probabilities_invalid");
    expect(
      decideMatchConfirmation(
        answer("matched", { matched: -0.2, not_matched: 0.6, uncertain: 0.6 }),
        POLICY,
      ).reason,
    ).toBe("probabilities_invalid");
  });

  it("选项冲突：matched 严格低于其它选项时降级", () => {
    const decision = decideMatchConfirmation(
      answer("matched", { matched: 0.2, not_matched: 0.5, uncertain: 0.3 }),
      POLICY,
    );
    expect(decision.result).toBe("uncertain");
    expect(decision.reason).toBe("choice_probability_conflict");
  });

  it("并列最高不算冲突，仍走门槛检查", () => {
    // 0.5 / 0.5 / 0：并列最高但低于门槛 → 门槛原因，不是冲突。
    const decision = decideMatchConfirmation(
      answer("matched", { matched: 0.5, not_matched: 0.5, uncertain: 0 }),
      POLICY,
    );
    expect(decision.reason).toBe("matched_probability_below_threshold");
  });

  it("0.80 边界：0.80 通过、0.7999 不通过、显示舍入不改变结果", () => {
    const pass = decideMatchConfirmation(
      answer("matched", { matched: 0.8, not_matched: 0.1, uncertain: 0.1 }),
      POLICY,
    );
    expect(pass.result).toBe("matched");
    expect(pass.reason).toBe("matched_confirmed");

    const below = decideMatchConfirmation(
      answer("matched", { matched: 0.7999, not_matched: 0.1, uncertain: 0.1001 }),
      POLICY,
    );
    expect(below.result).toBe("uncertain");
    expect(below.reason).toBe("matched_probability_below_threshold");
  });

  it("归档正例 p=(1,0,0) 仍确认匹配", () => {
    const decision = decideMatchConfirmation(
      answer("matched", { matched: 1, not_matched: 0, uncertain: 0 }),
      POLICY,
    );
    expect(decision.result).toBe("matched");
    expect(decision.reason).toBe("matched_confirmed");
  });
});

describe("置信度不参与门槛", () => {
  it("缺 confidence 但概率合法时仍按概率决策", () => {
    const parsed = parseAnswer({
      type: "choice",
      choice: "matched",
      probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
    });
    expect(parsed.confidence).toBeNull();
    const decision = decideMatchConfirmation(parsed, POLICY);
    expect(decision.result).toBe("matched");
  });

  it("confidence 越界不改变概率门控结果", () => {
    const parsed = parseAnswer({
      type: "choice",
      choice: "matched",
      probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
      confidence: 1.4,
    });
    expect(parsed.confidence).toBe(1.4);
    expect(decideMatchConfirmation(parsed, POLICY).result).toBe("matched");
  });

  it("策略版本与参数快照符合设计", () => {
    expect(MATCH_CONFIRMATION_POLICY_VERSION).toBe("match-confirmation-v1");
    expect(POLICY).toEqual({
      minMatchedProbability: 0.8,
      probabilitySumTolerance: 0.01,
    });
    // 冻结，防止运行期被改写。
    expect(Object.isFrozen(POLICY)).toBe(true);
  });
});
