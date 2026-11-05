import {
  EVALUATION_LABELS,
  MODEL_CHOICE_LABELS,
  formatConfidence,
  formatDecisionPolicy,
  formatDecisionReason,
  formatProbabilities,
  type ChoiceOutcomeDto,
  type DecisionPolicyDto,
  type DecisionReasonDto,
  type OfferAssessmentDto,
} from "@/components/api-types";

/** 两个页面共用原始证据展示；不从最终结果反推模型选择或历史促销判断。 */
export function MatchAssessment(props: {
  modelResult: ChoiceOutcomeDto | null;
  recorded: boolean;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  rawAnswer: string | null;
  offerAssessment: OfferAssessmentDto | null;
}) {
  const offer = props.offerAssessment;
  const offerLabels = {
    matched: "有明确促销信息",
    not_matched: "未提供该商品的促销信息",
    uncertain: "促销信息不足",
    failed: EVALUATION_LABELS.failed,
  };
  return (
    <div className="stack small" style={{ gap: "var(--sp-3)" }}>
      <div>
        <strong>需求相关性：</strong>
        {props.modelResult ? MODEL_CHOICE_LABELS[props.modelResult] : props.recorded ? "解析失败" : "未记录（历史）"}
        <div className="muted small">{formatProbabilities(props.probabilities)}</div>
        <div className="muted small">置信度：{formatConfidence(props.confidence)}</div>
      </div>
      {offer ? (
        <div>
          <strong>该需求促销：</strong>{offerLabels[offer.result]}
          <div className="muted small">{formatProbabilities(offer.probabilities)}</div>
          <div className="muted small">置信度：{formatConfidence(offer.confidence)}</div>
          {offer.error ? <div className="error">{offer.error}</div> : null}
        </div>
      ) : <div className="muted">历史判断，未记录促销识别</div>}
      {props.rawAnswer || offer?.rawAnswer ? (
        <details>
          <summary>两题原始答案</summary>
          <div className="muted small">需求相关性</div>
          <pre className="reading">{props.rawAnswer ?? "未记录"}</pre>
          <div className="muted small">该需求促销{offer ? `（${offer.questionId}）` : ""}</div>
          <pre className="reading">{offer?.rawAnswer ?? "未记录"}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function MatchDecisionTrace(props: {
  reason: DecisionReasonDto | null;
  policyVersion: string | null;
  policy: DecisionPolicyDto | null;
  matchedProbability: number | null;
  requestId: string | null;
}) {
  const threshold = props.policy && !("kind" in props.policy) ? props.policy.minMatchedProbability : null;
  return (
    <div className="small">
      {props.reason ? formatDecisionReason(props.reason, {
        matchedProbability: props.matchedProbability,
        minMatchedProbability: threshold,
      }) : "历史记录：未记录匹配确认策略"}
      <div className="muted small">{formatDecisionPolicy(props.policy)}</div>
      <div className="muted small">策略 {props.policyVersion ?? "未记录"}</div>
      {props.policy ? (
        <details>
          <summary>策略快照</summary>
          <pre className="reading">{JSON.stringify(props.policy, null, 2)}</pre>
        </details>
      ) : null}
      <div className="muted small" style={{ overflowWrap: "anywhere" }}>请求 ID：{props.requestId ?? "未记录"}</div>
    </div>
  );
}
