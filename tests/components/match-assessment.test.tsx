import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchAssessment, MatchDecisionTrace } from "@/components/MatchAssessment";
import { formatDecisionPolicy } from "@/components/api-types";

const policy = {
  kind: "need_and_offer" as const,
  relevance: { minMatchedProbability: null, probabilitySumTolerance: 0.01 },
  offer: { minMatchedProbability: null, probabilitySumTolerance: 0.01 },
};

describe("双维追溯展示（历史与当前策略不能混用）", () => {
  it("旧matched仅显示历史提示，不能反推已通过促销识别", () => {
    const markup = renderToStaticMarkup(<MatchAssessment modelResult="matched" recorded={true} probabilities={null} confidence={null} rawAnswer={null} offerAssessment={null} />);
    expect(markup).toContain("历史判断，未记录促销识别");
    expect(markup).not.toContain("有明确促销信息");
    expect(formatDecisionPolicy({ minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 })).toContain("0.8（历史单题策略）");
  });
  it("新双项策略显示真实null门槛和请求ID，不能显示旧0.8门槛", () => {
    const markup = renderToStaticMarkup(<MatchDecisionTrace reason="need_and_offer_confirmed" policyVersion="need-offer-confirmation-v1" policy={policy} matchedProbability={0.69} requestId="request-double" />);
    expect(markup).toContain("未设置额外概率门槛");
    expect(markup).toContain("request-double");
    expect(markup).toContain("minMatchedProbability&quot;: null");
    expect(markup).not.toContain("0.8");
  });
  it("促销缺答展示失败及真实错误，不冒充历史未记录，保留相关性原始选择", () => {
    const markup = renderToStaticMarkup(<MatchAssessment modelResult="matched" recorded={true} probabilities={{ matched: 0.76 }} confidence={null} rawAnswer='{"choice":"matched"}' offerAssessment={{ questionId: "offer_1", result: "failed", probabilities: null, confidence: null, rawAnswer: null, error: "缺少该问题的答案" }} />);
    expect(markup).toContain("需求相关性：");
    expect(markup).toContain("matched=0.76");
    expect(markup).toContain("处理失败");
    expect(markup).toContain("缺少该问题的答案");
    expect(markup).not.toContain("历史判断，未记录促销识别");
  });
});
