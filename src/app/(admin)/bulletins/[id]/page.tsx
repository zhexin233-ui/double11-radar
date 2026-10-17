"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  DELIVERY_LABELS,
  EVALUATION_LABELS,
  EVALUATION_MODE_LABELS,
  PROCESSING_SOURCE_LABELS,
  STATUS_LABELS,
  type BulletinDetailDto,
} from "@/components/api-types";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatProbabilities(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return Object.entries(parsed)
      .map(([key, value]) => `${key}=${value}`)
      .join("，");
  } catch {
    return "";
  }
}

export default function BulletinDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { data: detail, error, loading, reload } = useApiResource<BulletinDetailDto>(
    `/api/bulletins/${id}`,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
        <p>
          <Link href="/bulletins">← 返回线报记录</Link>
        </p>
        <Feedback kind="error">加载失败：{error}</Feedback>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <p>
          <Link href="/bulletins">← 返回线报记录</Link>
        </p>
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  const { bulletin } = detail;

  return (
    <div className="page">
      <header className="page-header">
        <p style={{ marginBottom: "var(--sp-4)" }}>
          <Link href="/bulletins">← 返回线报记录</Link>
        </p>
        <h1 style={{ overflowWrap: "anywhere" }}>{bulletin.title}</h1>
        <div className="page-actions">
          <StatusBadge status={detail.status}>{STATUS_LABELS[detail.status]}</StatusBadge>
          <span className="muted small">{bulletin.sourceNs}</span>
        </div>
      </header>

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind="success">{notice}</Feedback> : null}
      {error ? <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback> : null}

      <Section title="来源与原文">
        <dl className="facts">
          <dt>原始链接</dt>
          <dd>
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
          <dd>{formatTime(bulletin.publishedAt)}</dd>
        </dl>
        {bulletin.content ? (
          <>
            <h3 style={{ marginTop: "var(--sp-7)" }}>正文</h3>
            <pre className="reading">{bulletin.content}</pre>
          </>
        ) : null}
      </Section>

      {detail.processing ? (
        <Section title="处理策略与批次">
          <dl className="facts">
            <dt>判断模式</dt>
            <dd>{EVALUATION_MODE_LABELS[detail.processing.evaluationMode]}</dd>
            <dt>处理阶段</dt>
            <dd>{detail.processing.stage}</dd>
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
                <dd>{detail.processing.regexRuleCount}</dd>
              </>
            ) : null}
            {detail.processing.gateRequestId ? (
              <>
                <dt>初筛请求 ID</dt>
                <dd>{detail.processing.gateRequestId}</dd>
              </>
            ) : null}
            {detail.processing.batchPartId ? (
              <>
                <dt>子批 ID</dt>
                <dd>{detail.processing.batchPartId}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      ) : null}

      <Section title="命中需求与分类说明">
        {detail.matchedNeeds.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {detail.status === "failed"
              ? "本次判断存在处理失败，不能视为「没有匹配」。"
              : detail.status === "uncertain"
                ? "信息不足，留在待确认，未发送通知。"
                : detail.processing?.stage === "filtered"
                  ? (detail.processing.screeningReason ??
                    "该条未匹配本地规则，未调用 JEV。")
                  : "没有命中任何启用需求。"}
          </p>
        ) : (
          <div className="stack">
            <p style={{ margin: 0 }}>命中需求：{detail.matchedNeeds.join("、")}</p>
            <p className="muted small" style={{ margin: 0 }}>
              以下为<strong>程序生成的分类说明</strong>（不是模型生成的理由）：
            </p>
            <pre>{detail.explanation}</pre>
          </div>
        )}
      </Section>

      <Section title="逐需求判断">
        {detail.evaluations.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            尚无判断记录（可能仍在队列中）。
          </p>
        ) : (
          <TableScroll label="逐需求判断列表">
            <table>
              <thead>
                <tr>
                  <th>需求</th>
                  <th>结果</th>
                  <th>置信度</th>
                  <th>概率</th>
                  <th>说明 / 错误</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {detail.evaluations.map((evaluation) => (
                  <tr key={evaluation.id}>
                    <td>
                      {evaluation.needName}
                      <div className="muted small">v{evaluation.needVersion}</div>
                    </td>
                    <td>
                      <StatusBadge status={evaluation.result}>
                        {EVALUATION_LABELS[evaluation.result]}
                      </StatusBadge>
                    </td>
                    <td className="small">{evaluation.confidence ?? "—"}</td>
                    <td className="small">{formatProbabilities(evaluation.probabilities)}</td>
                    <td className="small error">{evaluation.error ?? ""}</td>
                    <td className="small">{formatTime(evaluation.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="投递状态">
        {detail.deliveries.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
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
                    <td className="small">{delivery.attempts}</td>
                    <td className="small">
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
