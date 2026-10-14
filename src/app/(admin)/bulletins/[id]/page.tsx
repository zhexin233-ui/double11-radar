"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  DELIVERY_LABELS,
  EVALUATION_LABELS,
  STATUS_LABELS,
  type BulletinDetailDto,
} from "@/components/api-types";

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
  const [busy, setBusy] = useState(false);

  async function retry(deliveryId: string) {
    setBusy(true);
    setNotice(null);
    try {
      await apiSend(`/api/deliveries/${deliveryId}/retry`, "POST", {});
      setNotice("已重新排队，worker 会按计划重试该渠道。");
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">加载失败：{error}</p>;
  if (loading || !detail) return <p className="muted">正在加载…</p>;

  const { bulletin } = detail;

  return (
    <div className="stack">
      <p>
        <Link href="/bulletins">← 返回线报记录</Link>
      </p>
      <h1>{bulletin.title}</h1>
      <div className="row">
        <span className={`badge ${detail.status}`}>{STATUS_LABELS[detail.status]}</span>
        <span className="muted small">{bulletin.sourceNs}</span>
      </div>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <section className="card">
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
            <h3>正文</h3>
            <pre>{bulletin.content}</pre>
          </>
        ) : null}
      </section>

      <section className="card">
        <h2>命中需求与分类说明</h2>
        {detail.matchedNeeds.length === 0 ? (
          <p className="muted">
            {detail.status === "failed"
              ? "本次判断存在处理失败，不能视为「没有匹配」。"
              : detail.status === "uncertain"
                ? "信息不足，留在待确认，未发送通知。"
                : "没有命中任何启用需求。"}
          </p>
        ) : (
          <>
            <p>命中需求：{detail.matchedNeeds.join("、")}</p>
            <p className="muted small">
              以下为<strong>程序生成的分类说明</strong>（不是模型生成的理由）：
            </p>
            <pre>{detail.explanation}</pre>
          </>
        )}
      </section>

      <section className="card">
        <h2>逐需求判断</h2>
        {detail.evaluations.length === 0 ? (
          <p className="muted">尚无判断记录（可能仍在队列中）。</p>
        ) : (
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
                    <span className={`badge ${evaluation.result}`}>
                      {EVALUATION_LABELS[evaluation.result]}
                    </span>
                  </td>
                  <td className="small">{evaluation.confidence ?? "—"}</td>
                  <td className="small">{formatProbabilities(evaluation.probabilities)}</td>
                  <td className="small error">{evaluation.error ?? ""}</td>
                  <td className="small">{formatTime(evaluation.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>投递状态</h2>
        {detail.deliveries.length === 0 ? (
          <p className="muted">没有渠道投递记录（可能两个渠道都关闭，或尚未命中）。</p>
        ) : (
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
                    <span className={`badge ${delivery.status}`}>
                      {DELIVERY_LABELS[delivery.status]}
                    </span>
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
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => void retry(delivery.id)}
                      >
                        重试该渠道
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
