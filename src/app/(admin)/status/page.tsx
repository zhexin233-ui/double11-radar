"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  ALERT_DISPATCH_LABELS,
  ALERT_DELIVERY_LABELS,
  deliveryLabel,
  type StatusDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function jobKindLabel(kind: string): string {
  switch (kind) {
    case "evaluate":
      return "判断";
    case "screen_batch":
      return "预筛";
    case "analyze":
      return "深度核验";
    default:
      return "投递";
  }
}

export default function StatusPage() {
  const { data: status, error, loading, reload } = useApiResource<StatusDto>(
    "/api/status",
    { refreshMs: 15000 },
  );
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const handleRetryJobs = async (id?: string) => {
    const key = id ?? "__all__";
    setRetryingKey(key);
    setRetryFeedback(null);
    try {
      const result = await apiSend<{ retried: number }>(
        "/api/jobs/retry",
        "POST",
        id ? { id } : {},
      );
      setRetryFeedback({
        kind: "success",
        text:
          result.retried > 0
            ? `已重新入队 ${result.retried} 条失败任务，后台将尽快重跑。`
            : "当前没有可重试的失败任务。",
      });
      await reload();
    } catch (err) {
      setRetryFeedback({
        kind: "error",
        text: `重试失败任务出错：${errorMessage(err)}`,
      });
    } finally {
      setRetryingKey(null);
    }
  };

  const header = (
    <PageHeader
      title="运行状态"
      lead="查看后台进程、采集与投递的真实健康状况。异常会紧随摘要显示，不会沉到底部。"
      actions={
        <Button
          variant="default"
          size="sm"
          loading={loading && Boolean(status)}
          onClick={() => void reload()}
        >
          刷新
        </Button>
      }
    />
  );

  if (error && !status) {
    return (
      <div className="page">
        {header}
        <Feedback kind="error">加载状态失败：{error}</Feedback>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="page">
        {header}
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  const { worker, channels, jobs, counts } = status;

  return (
    <div className="page">
      {header}

      <div className="meta-strip">
        <div className="meta-item">
          <span className="meta-item-label">系统状态</span>
          <div>
            <StatusBadge status={status.processingHealthy ? "matched" : "failed"}>
              {status.processingHealthy ? "后台运行正常" : "处理故障"}
            </StatusBadge>
          </div>
        </div>
        <div className="meta-item">
          <span className="meta-item-label">上次匹配时间</span>
          <span className="meta-item-value mono">
            {formatTime(counts.lastMatchedAt)}
          </span>
        </div>
        <div className="meta-item" style={{ flex: "1 1 280px" }}>
          <span className="meta-item-label">运行说明</span>
          {status.processingHealthy ? (
            <span className="muted small">
              「没有匹配」表示已正常判断但没有命中需求，与处理故障不同。
            </span>
          ) : (
            <span className="error small" role="alert">
              后台可能未运行或存在失败任务/频道错误，请勿把当前状态理解为「没有匹配」。
            </span>
          )}
        </div>
      </div>

      {error ? (
        <Feedback kind="error">
          刷新失败：{error}（下方为上次成功数据）
        </Feedback>
      ) : null}

      <Section title="关键统计">
        <div className="stats">
          <div className="stat-cell">
            <div className="stat-label">明确匹配线报</div>
            <div className="stat-value">{counts.matchedBulletins}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">待确认线报</div>
            <div className="stat-value">{counts.uncertainBulletins}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">处理失败线报</div>
            <div
              className={
                counts.failedEvaluations ? "stat-value error" : "stat-value"
              }
            >
              {counts.failedEvaluations}
            </div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">通知总数</div>
            <div className="stat-value">{counts.notificationCount}</div>
          </div>
        </div>
      </Section>

      <div className="grid-2">
        <Section title="后台进程" headingLevel={2} alt>
          <dl className="facts">
            <dt>心跳</dt>
            <dd className="mono">{formatTime(worker.lastHeartbeatAt)}</dd>
            <dt>启动时间</dt>
            <dd className="mono">{formatTime(worker.workerStartedAt)}</dd>
            <dt>最后采集</dt>
            <dd className="mono">{formatTime(worker.lastCollectAt)}</dd>
            <dt>最后判断</dt>
            <dd className="mono">{formatTime(worker.lastEvaluateAt)}</dd>
            <dt>最后投递</dt>
            <dd className="mono">{formatTime(worker.lastDeliverAt)}</dd>
            <dt>采集限流</dt>
            <dd className={worker.rateLimitBackoffUntil ? "warning" : "muted"}>
              {worker.rateLimitBackoffUntil
                ? `已暂停采集至 ${formatTime(worker.rateLimitBackoffUntil)}（额度剩余 ${worker.rateLimitRemaining ?? "未知"}）`
                : worker.rateLimitRemaining === null
                  ? "未观察到限流头"
                  : `额度剩余 ${worker.rateLimitRemaining}`}
            </dd>
            <dt>最近错误</dt>
            <dd className={worker.lastError ? "error" : "muted"}>
              {worker.lastError ?? "无"}
              {worker.lastErrorAt ? `（${formatTime(worker.lastErrorAt)}）` : ""}
            </dd>
          </dl>
          <p
            className="muted small"
            style={{ marginTop: "var(--sp-4)", marginBottom: 0 }}
          >
            worker 为独立进程，关闭本网页不会停止采集与判断。
          </p>
        </Section>

        <Section title="频道与任务" headingLevel={2} alt>
          <dl className="facts">
            <dt>频道总数</dt>
            <dd className="mono">{channels.stats.total}</dd>
            <dt>已启用</dt>
            <dd className="mono">{channels.stats.selected}</dd>
            <dt>已建立基线</dt>
            <dd className="mono">{channels.stats.initialized}</dd>
            <dt>采集报错频道</dt>
            <dd className={channels.stats.failing ? "mono error" : "mono"}>
              {channels.stats.failing}
            </dd>
            <dt>待处理任务</dt>
            <dd className="mono">
              {jobs.pending}（进行中 {jobs.leased}）
            </dd>
            <dt>失败任务</dt>
            <dd className={jobs.activeDead ? "mono error" : "mono"}>
              {jobs.dead > 0 && jobs.activeDead === 0
                ? `${jobs.dead}（历史，已恢复）`
                : jobs.dead}
            </dd>
          </dl>
        </Section>

        <Section title="投递状态" headingLevel={2} alt>
          {Object.keys(counts.delivery).length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              暂无投递记录。
            </p>
          ) : (
            <dl className="facts">
              {Object.entries(counts.delivery).map(([state, value]) => (
                <div key={state} style={{ display: "contents" }}>
                  <dt>{deliveryLabel(state)}</dt>
                  <dd className="mono">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        <Section title="处理说明" headingLevel={2} alt>
          <p className="muted small" style={{ margin: 0, lineHeight: 1.7 }}>
            「明确匹配」「待确认（信息不足或未通过匹配确认）」「处理失败」「没有匹配」互相区分；
            处理失败是模型或调用异常，不代表没有命中。
          </p>
        </Section>
      </div>

      <Section
        title="系统密钥通知"
        description="最多显示最近 10 条密钥自动停用与重新启用事件（诊断快照，不分页）；独立于线报通知统计。"
      >
        {status.systemAlerts.length === 0 ? (
          <p className="empty">暂无系统告警。</p>
        ) : (
          <TableScroll label="最近系统密钥通知">
            <table>
              <thead>
                <tr>
                  <th>模型渠道 / 密钥</th>
                  <th>事件 / 说明</th>
                  <th>发生时间</th>
                  <th>通知渠道状态</th>
                </tr>
              </thead>
              <tbody>
                {status.systemAlerts.map((alert) => (
                  <tr key={alert.id}>
                    <td>
                      {alert.channelName} / {alert.keyLabel}
                    </td>
                    <td className="small">
                      {alert.eventType === "key_auto_reenabled"
                        ? `已自动重新启用（此前连续 ${alert.consecutiveFailures} 次失败）`
                        : `连续 ${alert.consecutiveFailures} 次失败，已自动停用`}
                      <div className="muted">{alert.reason}</div>
                    </td>
                    <td className="small mono">{formatTime(alert.occurredAt)}</td>
                    <td className="small">
                      {ALERT_DISPATCH_LABELS[alert.dispatchStatus]}
                      {alert.deliveries.map((delivery) => (
                        <div key={delivery.channel}>
                          {delivery.channel === "bark" ? "Bark" : "飞书"}：
                          {ALERT_DELIVERY_LABELS[delivery.status]}（
                          {delivery.attempts}/5 次）
                          {delivery.lastError ? (
                            <div className="muted">{delivery.lastError}</div>
                          ) : null}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      {channels.failing.length > 0 ? (
        <Section
          title="频道错误"
          description={`共 ${channels.stats.failing} 个频道采集报错（诊断快照，不分页）。`}
        >
          <TableScroll label="频道错误列表">
            <table>
              <thead>
                <tr>
                  <th>频道</th>
                  <th>错误</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {channels.failing.map((channel) => (
                  <tr key={channel.id}>
                    <td>{channel.name}</td>
                    <td className="error small">{channel.lastError}</td>
                    <td className="small mono">
                      {formatTime(channel.lastErrorAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Section>
      ) : null}

      {status.recentFailedJobs.length > 0 ? (
        <Section
          title="最近失败任务"
          description="最多显示最近 10 条（诊断快照，不分页）。后续同类型任务已恢复成功时，历史失败任务不再阻塞系统健康状态，可按需手动重试。"
          actions={
            jobs.dead > 0 ? (
              <Button
                variant="default"
                size="xs"
                loading={retryingKey === "__all__"}
                disabled={retryingKey !== null}
                onClick={() => void handleRetryJobs()}
              >
                重试全部失败任务（{jobs.dead}）
              </Button>
            ) : undefined
          }
        >
          {retryFeedback ? (
            <div style={{ marginBottom: "var(--sp-3)" }}>
              <Feedback kind={retryFeedback.kind}>{retryFeedback.text}</Feedback>
            </div>
          ) : null}
          <TableScroll label="最近失败任务列表">
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>错误</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {status.recentFailedJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{jobKindLabel(job.kind)}</td>
                    <td>{job.status}</td>
                    <td className="mono">{job.attempts}</td>
                    <td className="small">{job.lastError}</td>
                    <td className="small mono">{formatTime(job.updatedAt)}</td>
                    <td>
                      {job.status === "dead" ? (
                        <Button
                          variant="subtle"
                          size="xs"
                          loading={retryingKey === job.id}
                          disabled={retryingKey !== null}
                          onClick={() => void handleRetryJobs(job.id)}
                        >
                          重试
                        </Button>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Section>
      ) : null}
    </div>
  );
}
