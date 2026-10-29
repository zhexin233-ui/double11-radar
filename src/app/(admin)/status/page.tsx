"use client";

import { Button } from "@mantine/core";
import { useApiResource } from "@/components/use-api";
import { ALERT_DISPATCH_LABELS, ALERT_DELIVERY_LABELS, deliveryLabel, type StatusDto } from "@/components/api-types";
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

export default function StatusPage() {
  const { data: status, error, loading, reload } = useApiResource<StatusDto>(
    "/api/status",
    { refreshMs: 15000 },
  );

  const header = (
    <PageHeader
      title="运行状态"
      lead="查看后台进程、采集与投递的真实健康状况。异常会紧随摘要显示，不会沉到底部。"
      actions={
        <Button variant="default" size="sm" onClick={() => void reload()}>
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

      <Section alt>
        <div className="stack">
          <StatusBadge status={status.processingHealthy ? "matched" : "failed"}>
            {status.processingHealthy ? "后台运行正常" : "处理故障"}
          </StatusBadge>
          {status.processingHealthy ? (
            <p className="muted small" style={{ margin: 0 }}>
              上次匹配时间：{formatTime(counts.lastMatchedAt)}。
              「没有匹配」表示已正常判断但没有命中需求，与处理故障不同。
            </p>
          ) : (
            <p className="error small" style={{ margin: 0 }} role="alert">
              后台可能未运行或存在失败任务/频道错误，请勿把当前状态理解为「没有匹配」。
            </p>
          )}
          {error ? <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback> : null}
        </div>
      </Section>

      <Section title="关键统计">
        <div className="stats">
          <div>
            <div className="stat-value">{counts.matchedBulletins}</div>
            <div className="stat-label">明确匹配线报</div>
          </div>
          <div>
            <div className="stat-value">{counts.uncertainBulletins}</div>
            <div className="stat-label">待确认线报</div>
          </div>
          <div>
            <div className={counts.failedEvaluations ? "stat-value error" : "stat-value"}>
              {counts.failedEvaluations}
            </div>
            <div className="stat-label">处理失败线报</div>
          </div>
          <div>
            <div className="stat-value">{counts.notificationCount}</div>
            <div className="stat-label">通知总数</div>
          </div>
        </div>
      </Section>

      <div className="grid-2">
        <Section title="后台进程" headingLevel={2} alt>
          <dl className="facts small">
            <dt>心跳</dt>
            <dd>{formatTime(worker.lastHeartbeatAt)}</dd>
            <dt>启动时间</dt>
            <dd>{formatTime(worker.workerStartedAt)}</dd>
            <dt>最后采集</dt>
            <dd>{formatTime(worker.lastCollectAt)}</dd>
            <dt>最后判断</dt>
            <dd>{formatTime(worker.lastEvaluateAt)}</dd>
            <dt>最后投递</dt>
            <dd>{formatTime(worker.lastDeliverAt)}</dd>
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
          <p className="muted small" style={{ marginTop: "var(--sp-4)", marginBottom: 0 }}>
            worker 为独立进程，关闭本网页不会停止采集与判断。
          </p>
        </Section>

        <Section title="频道与任务" headingLevel={2} alt>
          <dl className="facts small">
            <dt>频道总数</dt>
            <dd>{channels.stats.total}</dd>
            <dt>已启用</dt>
            <dd>{channels.stats.selected}</dd>
            <dt>已建立基线</dt>
            <dd>{channels.stats.initialized}</dd>
            <dt>采集报错频道</dt>
            <dd className={channels.stats.failing ? "error" : ""}>
              {channels.stats.failing}
            </dd>
            <dt>待处理任务</dt>
            <dd>
              {jobs.pending}（进行中 {jobs.leased}）
            </dd>
            <dt>失败任务</dt>
            <dd className={jobs.dead ? "error" : ""}>{jobs.dead}</dd>
          </dl>
        </Section>

        <Section title="投递状态" headingLevel={2} alt>
          {Object.keys(counts.delivery).length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              暂无投递记录。
            </p>
          ) : (
            <dl className="facts small">
              {Object.entries(counts.delivery).map(([state, value]) => (
                <div key={state} style={{ display: "contents" }}>
                  <dt>{deliveryLabel(state)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        <Section title="处理说明" headingLevel={2} alt>
          <p className="muted small" style={{ margin: 0 }}>
            「明确匹配」「待确认（信息不足或未通过匹配确认）」「处理失败」「没有匹配」互相区分；
            处理失败是模型或调用异常，不代表没有命中。
          </p>
        </Section>
      </div>

      <Section title="系统密钥通知" description="最多显示最近 10 条密钥自动停用与重新启用事件（诊断快照，不分页）；独立于线报通知统计。">
        {status.systemAlerts.length === 0 ? <p className="muted small">暂无系统告警。</p> : (
          <TableScroll label="最近系统密钥通知">
            <table>
              <thead><tr><th>模型渠道 / 密钥</th><th>事件 / 说明</th><th>发生时间</th><th>通知渠道状态</th></tr></thead>
              <tbody>{status.systemAlerts.map((alert) => (
                <tr key={alert.id}>
                  <td>{alert.channelName} / {alert.keyLabel}</td>
                  <td className="small">{alert.eventType === "key_auto_reenabled" ? `已自动重新启用（此前连续 ${alert.consecutiveFailures} 次失败）` : `连续 ${alert.consecutiveFailures} 次失败，已自动停用`}<br />{alert.reason}</td>
                  <td className="small">{formatTime(alert.occurredAt)}</td>
                  <td className="small">{ALERT_DISPATCH_LABELS[alert.dispatchStatus]}
                    {alert.deliveries.map((delivery) => <div key={delivery.channel}>
                      {delivery.channel === "bark" ? "Bark" : "飞书"}：{ALERT_DELIVERY_LABELS[delivery.status]}（{delivery.attempts}/5 次）
                      {delivery.lastError ? <div className="muted">{delivery.lastError}</div> : null}
                    </div>)}
                  </td>
                </tr>
              ))}</tbody>
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
                    <td className="small">{formatTime(channel.lastErrorAt)}</td>
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
          description="最多显示最近 10 条（诊断快照，不分页）。"
        >
          <TableScroll label="最近失败任务列表">
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>错误</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {status.recentFailedJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.kind === "evaluate" ? "判断" : "投递"}</td>
                    <td>{job.status}</td>
                    <td>{job.attempts}</td>
                    <td className="small">{job.lastError}</td>
                    <td className="small">{formatTime(job.updatedAt)}</td>
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
