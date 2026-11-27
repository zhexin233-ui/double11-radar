"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { useParams } from "next/navigation";
import { Badge, Button, Group } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { formatStarRating } from "@/components/format";
import { useApiResource } from "@/components/use-api";
import {
  ANALYSIS_VERDICT_LABELS,
  DELIVERY_LABELS,
  EVALUATION_LABELS,
  EVALUATION_MODE_LABELS,
  PROCESSING_SOURCE_LABELS,
  STATUS_LABELS,
  parseProbabilityRecord,
  type AnalysisVerdictDto,
  type BulletinDetailDto,
} from "@/components/api-types";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";
import {
  MatchAssessment,
  MatchDecisionTrace,
} from "@/components/MatchAssessment";
import { StatusBadge } from "@/components/status-badge";
import { ArrowLeftIcon } from "@/components/ui/Icons";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function BulletinDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const {
    data: detail,
    error,
    reload,
  } = useApiResource<BulletinDetailDto>(`/api/bulletins/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  async function triggerAnalyze() {
    setAnalyzing(true);
    setActionError(null);
    setNotice(null);
    try {
      await apiSend(`/api/bulletins/${id}/analyze`, "POST", {});
      setNotice("二级深度核验已完成并更新简报。");
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setAnalyzing(false);
    }
  }

  async function retry(deliveryId: string) {
    setBusyId(deliveryId);
    setNotice(null);
    try {
      await apiSend(`/api/deliveries/${deliveryId}/retry`, "POST", {});
      setNotice("已重新排队，worker 会按计划重试该渠道。");
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  if (error && !detail) {
    return (
      <div className="page">
        <Link className="back-link" href="/bulletins">
          <ArrowLeftIcon />
          <span>返回线报记录</span>
        </Link>
        <Feedback kind="error">加载失败：{error}</Feedback>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <Link className="back-link" href="/bulletins">
          <ArrowLeftIcon />
          <span>返回线报记录</span>
        </Link>
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  const { bulletin } = detail;
  const ratings = detail.analysis?.answer?.ratings;

  return (
    <div className="page">
      <header className="page-header">
        <Link className="back-link" href="/bulletins">
          <ArrowLeftIcon />
          <span>返回线报记录</span>
        </Link>
        <h1 style={{ overflowWrap: "anywhere", maxWidth: "var(--reading-max)" }}>
          {bulletin.title}
        </h1>
        <div className="page-actions" style={{ marginTop: "var(--sp-3)" }}>
          <StatusBadge status={detail.status}>
            {STATUS_LABELS[detail.status]}
          </StatusBadge>
          <span className="muted small mono">{bulletin.sourceNs}</span>
          <span className="muted small mono">
            {formatTime(bulletin.publishedAt)}
          </span>
        </div>
      </header>

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind="success">{notice}</Feedback> : null}
      {error ? (
        <Feedback kind="error">
          刷新失败：{error}（下方为上次成功数据）
        </Feedback>
      ) : null}

      <Section title="来源与原文" alt>
        <dl className="facts">
          <dt>原始链接</dt>
          <dd className="mono">
            <a href={bulletin.url} target="_blank" rel="noreferrer">
              {bulletin.url}
            </a>
          </dd>
          <dt>来源品类</dt>
          <dd>{bulletin.category ?? "—"}</dd>
          <dt>品牌 / 商城</dt>
          <dd>
            {bulletin.brand ?? "—"} / {bulletin.mall ?? "—"}
          </dd>
          <dt>原文价格</dt>
          <dd>
            {bulletin.price === null
              ? "无（来源未提供，显示为空而不是 0 元）"
              : `${bulletin.price} 元（来源标注，不代表券后实付）`}
          </dd>
          <dt>发布时间</dt>
          <dd className="mono">{formatTime(bulletin.publishedAt)}</dd>
        </dl>
        {bulletin.content ? (
          <div className="divider-block" style={{ marginTop: "var(--sp-5)" }}>
            <h3 style={{ marginBottom: "var(--sp-3)" }}>正文</h3>
            <pre className="reading">{bulletin.content}</pre>
          </div>
        ) : null}
      </Section>

      {detail.processing ? (
        <Section title="处理策略与批次" alt>
          <dl className="facts">
            <dt>判断模式</dt>
            <dd>{EVALUATION_MODE_LABELS[detail.processing.evaluationMode]}</dd>
            <dt>处理阶段</dt>
            <dd className="mono">{detail.processing.stage}</dd>
            {detail.processing.screeningSource ? (
              <>
                <dt>过滤来源</dt>
                <dd>
                  {PROCESSING_SOURCE_LABELS[detail.processing.screeningSource]}
                  {detail.processing.matchedRuleIndex !== null
                    ? `（正则预筛命中第 ${detail.processing.matchedRuleIndex + 1} 条规则）`
                    : ""}
                </dd>
              </>
            ) : null}
            {detail.processing.screeningReason ? (
              <>
                <dt>说明</dt>
                <dd>{detail.processing.screeningReason}</dd>
              </>
            ) : null}
            {detail.processing.needSnapshotNames ? (
              <>
                <dt>批次需求快照</dt>
                <dd>{detail.processing.needSnapshotNames.join("、") || "—"}</dd>
              </>
            ) : null}
            {detail.processing.regexRuleCount !== null ? (
              <>
                <dt>正则规则数</dt>
                <dd className="mono">{detail.processing.regexRuleCount}</dd>
              </>
            ) : null}
            {detail.processing.gateRequestId ? (
              <>
                <dt>初筛请求 ID</dt>
                <dd className="mono">{detail.processing.gateRequestId}</dd>
              </>
            ) : null}
            {detail.processing.batchPartId ? (
              <>
                <dt>子批 ID</dt>
                <dd className="mono">{detail.processing.batchPartId}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}

      <Section title="命中需求与分类说明" alt>
        <div className="stack">
          {detail.hasHistoricalMatched ? (
            <Feedback kind="notice">
              含历史判定，未记录促销识别或未按当前策略重算；下方追溯字段仅适用于升级后新产生的判断。
            </Feedback>
          ) : null}
          {detail.matchedNeeds.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              {detail.status === "failed"
                ? "本次判断存在处理失败，不能视为「没有匹配」。"
                : detail.status === "uncertain"
                  ? detail.notification
                    ? "本次为待确认，不产生新的匹配通知；已有通知与投递见下方。"
                    : "本次为待确认，不产生新的匹配通知。"
                  : detail.processing?.stage === "filtered"
                    ? (detail.processing.screeningReason ??
                      "该条未匹配本地规则，未调用 JEV。")
                    : "没有命中任何启用需求。"}
            </p>
          ) : (
            <div className="stack">
              <p style={{ margin: 0 }}>
                命中需求：<strong>{detail.matchedNeeds.join("、")}</strong>
              </p>
              <p className="muted small" style={{ margin: 0 }}>
                以下为<strong>程序生成的分类说明</strong>（不是模型生成的理由）：
              </p>
              <pre>{detail.explanation}</pre>
            </div>
          )}
        </div>
      </Section>

      <Section title="逐需求判断">
        {detail.evaluations.length === 0 ? (
          <p className="empty">尚无判断记录（可能仍在队列中）。</p>
        ) : (
          <>
            <TableScroll label="逐需求判断列表" minTableWidth={1100}>
              <table>
                <thead>
                  <tr>
                    <th>需求</th>
                    <th>两项原始判断 / 概率</th>
                    <th style={{ minWidth: 104 }}>业务结果</th>
                    <th>程序判定</th>
                    <th>错误</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.evaluations.map((evaluation) => {
                    const probabilities = parseProbabilityRecord(
                      evaluation.probabilities,
                    );
                    return (
                      <tr key={evaluation.id}>
                        <td>
                          <strong>{evaluation.needName}</strong>
                          <div className="muted small mono">
                            v{evaluation.needVersion}
                          </div>
                          {evaluation.needNote ? (
                            <div className="muted small">
                              备注：{evaluation.needNote}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <MatchAssessment
                            modelResult={evaluation.modelResult}
                            recorded={evaluation.decisionReason !== null}
                            probabilities={probabilities}
                            confidence={evaluation.confidence}
                            rawAnswer={evaluation.rawAnswer}
                            offerAssessment={evaluation.offerAssessment}
                          />
                        </td>
                        <td>
                          <StatusBadge status={evaluation.result}>
                            {EVALUATION_LABELS[evaluation.result]}
                          </StatusBadge>
                        </td>
                        <td>
                          <MatchDecisionTrace
                            reason={evaluation.decisionReason}
                            policyVersion={evaluation.decisionPolicyVersion}
                            policy={evaluation.decisionPolicy}
                            matchedProbability={probabilities?.matched ?? null}
                            requestId={evaluation.jevRequestId}
                          />
                          <div className="muted small mono">
                            规则 {evaluation.ruleVersion} · 配置 v
                            {evaluation.configVersion}
                          </div>
                        </td>
                        <td className="small error">{evaluation.error ?? ""}</td>
                        <td className="small mono">
                          {formatTime(evaluation.updatedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            <p
              className="muted small"
              style={{ marginTop: "var(--sp-3)", marginBottom: 0 }}
            >
              置信度表示上游概率分布的集中程度，<strong>不代表业务正确率</strong>；
              新判断须需求相关与该需求促销两项明确通过，且各自概率分布完整合法；历史策略按保存的快照展示。
            </p>
          </>
        )}
      </Section>

      <Section
        title="二级深度核验简报"
        actions={
          <Button
            size="compact-sm"
            variant="default"
            loading={analyzing}
            onClick={() => void triggerAnalyze()}
          >
            手动触发二级核验
          </Button>
        }
      >
        {!detail.analysis ? (
          <p className="empty">
            暂无二级深度核验记录（可能未开启第二级，或该线报未进入二级核验）。
          </p>
        ) : (
          <div style={{ display: "grid", gap: "var(--sp-3)" }}>
            <Group gap="sm" wrap="wrap">
              {detail.analysis.verdict ? (
                <Badge
                  color={
                    (
                      {
                        recommended: "teal",
                        acceptable: "blue",
                        rejected: "red",
                        insufficient_info: "yellow",
                      } satisfies Record<AnalysisVerdictDto, string>
                    )[detail.analysis.verdict]
                  }
                  variant="light"
                >
                  {ANALYSIS_VERDICT_LABELS[detail.analysis.verdict]}
                </Badge>
              ) : (
                <Badge color="red" variant="light">
                  核验失败
                </Badge>
              )}
              <span className="muted small mono">
                模型：{detail.analysis.model} | 步数：{detail.analysis.stepsUsed} | 耗时：
                {detail.analysis.durationMs}ms
              </span>
              {detail.analysis.fallbackNotified ? (
                <Badge color="orange" variant="light">
                  已降级按一级原文推送
                </Badge>
              ) : null}
            </Group>

            {detail.analysis.error ? (
              <Feedback kind="error">{detail.analysis.error}</Feedback>
            ) : null}

            {ratings ? (
              <div className="stack-sm">
                <h3>量化评分</h3>
                <dl className="facts">
                  {[
                    { label: "综合推荐", score: ratings.overall },
                    { label: "价格力度", score: ratings.priceValue },
                    { label: "需求契合", score: ratings.needMatch },
                    { label: "下单省心", score: ratings.orderEase },
                    { label: "低风险度", score: ratings.lowRisk },
                  ].map(({ label, score }) => (
                    <Fragment key={label}>
                      <dt>{label}</dt>
                      <dd>{formatStarRating(score)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            ) : null}

            {detail.analysis.answer ? (
              <dl className="facts">
                <dt>核验摘要</dt>
                <dd>{detail.analysis.answer.summary}</dd>

                <dt>商品规格</dt>
                <dd>{detail.analysis.answer.productName}</dd>

                <dt>到手与折算单价</dt>
                <dd className="mono">
                  {detail.analysis.answer.actualTotalPrice !== null
                    ? `${detail.analysis.answer.actualTotalPrice} 元`
                    : "未标明总价"}
                  {detail.analysis.answer.unitPrice !== null &&
                  detail.analysis.answer.unitLabel
                    ? ` · ${detail.analysis.answer.unitPrice} ${detail.analysis.answer.unitLabel}`
                    : ""}
                  {detail.analysis.answer.priceFormula ? (
                    <div className="muted small">
                      算式：{detail.analysis.answer.priceFormula}
                    </div>
                  ) : null}
                </dd>

                <dt>比价结论</dt>
                <dd>
                  {detail.analysis.answer.priceComparison.conclusion}
                  {detail.analysis.answer.priceComparison.referencePrice !== null
                    ? `（参考价 ${detail.analysis.answer.priceComparison.referencePrice} 元${
                        detail.analysis.answer.priceComparison.source
                          ? ` · 来源：${detail.analysis.answer.priceComparison.source}`
                          : ""
                      }）`
                    : ""}
                </dd>

                {detail.analysis.answer.orderSteps.length > 0 ? (
                  <>
                    <dt>下单步骤</dt>
                    <dd>{detail.analysis.answer.orderSteps.join(" → ")}</dd>
                  </>
                ) : null}

                <dt>需求约束核对</dt>
                <dd>
                  {detail.analysis.answer.requirementChecks.length === 0 ? (
                    <span className="muted">无</span>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                      {detail.analysis.answer.requirementChecks.map((rc, i) => (
                        <li key={i}>
                          <strong>{rc.needName}</strong>：
                          {rc.satisfied ? "满足" : "不满足"}（{rc.reason}）
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>

                {detail.analysis.answer.risks.length > 0 ? (
                  <>
                    <dt>风险提示</dt>
                    <dd>{detail.analysis.answer.risks.join("；")}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            <div className="muted small mono">
              本次注入工具：
              {detail.analysis.activeToolIds.length > 0
                ? detail.analysis.activeToolIds.join(", ")
                : "（无工具，纯单轮核验）"}
            </div>

            {detail.analysis.toolTrace.length > 0 ? (
              <details>
                <summary className="small muted" style={{ cursor: "pointer" }}>
                  查看工具调用轨迹（{detail.analysis.toolTrace.length} 次调用）
                </summary>
                <TableScroll label="工具调用轨迹">
                  <table>
                    <thead>
                      <tr>
                        <th>步数</th>
                        <th>工具</th>
                        <th>参数</th>
                        <th>状态</th>
                        <th>耗时</th>
                        <th>返回摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.analysis.toolTrace.map((t, idx) => (
                        <tr key={idx}>
                          <td className="mono small">{t.step}</td>
                          <td className="mono small">{t.toolName}</td>
                          <td className="mono small" style={{ maxWidth: 220 }}>
                            {JSON.stringify(t.arguments)}
                          </td>
                          <td>
                            <Badge
                              color={
                                t.ok
                                  ? "teal"
                                  : t.infrastructureFailure
                                    ? "red"
                                    : "yellow"
                              }
                              variant="light"
                            >
                              {t.ok
                                ? "成功"
                                : t.infrastructureFailure
                                  ? "基础设施故障"
                                  : "业务无结果"}
                            </Badge>
                          </td>
                          <td className="mono small">{t.durationMs}ms</td>
                          <td className="small" style={{ maxWidth: 280 }}>
                            {t.resultPreview}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </details>
            ) : null}
          </div>
        )}
      </Section>

      <Section title="投递状态">
        {detail.deliveries.length === 0 ? (
          <p className="empty">
            没有渠道投递记录（可能两个渠道都关闭，或尚未命中）。
          </p>
        ) : (
          <TableScroll label="渠道投递列表">
            <table>
              <thead>
                <tr>
                  <th>渠道</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>HTTP / 业务码</th>
                  <th>失败原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{delivery.channel === "bark" ? "Bark" : "飞书"}</td>
                    <td>
                      <StatusBadge status={delivery.status}>
                        {DELIVERY_LABELS[delivery.status]}
                      </StatusBadge>
                    </td>
                    <td className="small mono">{delivery.attempts}</td>
                    <td className="small mono">
                      {delivery.httpStatus ?? "—"} / {delivery.bizCode ?? "—"}
                    </td>
                    <td className="small error">{delivery.error ?? ""}</td>
                    <td>
                      {delivery.status === "succeeded" ? (
                        <span className="muted small">无需重试</span>
                      ) : (
                        <Button
                          variant="default"
                          size="compact-sm"
                          loading={busyId === delivery.id}
                          disabled={busyId !== null && busyId !== delivery.id}
                          onClick={() => void retry(delivery.id)}
                        >
                          重试该渠道
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
    </div>
  );
}
