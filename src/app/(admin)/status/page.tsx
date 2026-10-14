"use client";

import { useApiResource } from "@/components/use-api";
import type { StatusDto } from "@/components/api-types";

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

  if (error) return <p className="error">加载状态失败：{error}</p>;
  if (loading || !status) return <p className="muted">正在加载…</p>;

  const { worker, channels, jobs, counts } = status;

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>运行状态</h1>
        <button type="button" className="ghost" onClick={() => void reload()}>
          刷新
        </button>
      </div>

      {status.processingHealthy ? (
        <div className="card">
          <span className="badge matched">后台运行正常</span>
          <p className="muted small">
            上次匹配时间：{formatTime(counts.lastMatchedAt)}。
            「没有匹配」表示已正常判断但没有命中需求，与处理故障不同。
          </p>
        </div>
      ) : (
        <div className="card">
          <span className="badge failed">处理故障</span>
          <p className="error small">
            后台可能未运行或存在失败任务/频道错误，请勿把当前状态理解为「没有匹配」。
          </p>
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>后台进程</h2>
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
          <p className="muted small">
            worker 为独立进程，关闭本网页不会停止采集与判断。
          </p>
        </section>

        <section className="card">
          <h2>频道与任务</h2>
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
        </section>

        <section className="card">
          <h2>处理统计</h2>
          <dl className="facts small">
            <dt>明确匹配线报</dt>
            <dd>{counts.matchedBulletins}</dd>
            <dt>待确认线报</dt>
            <dd>{counts.uncertainBulletins}</dd>
            <dt>处理失败线报</dt>
            <dd className={counts.failedEvaluations ? "error" : ""}>
              {counts.failedEvaluations}
            </dd>
            <dt>通知总数</dt>
            <dd>{counts.notificationCount}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>投递状态</h2>
          {Object.keys(counts.delivery).length === 0 ? (
            <p className="muted small">暂无投递记录。</p>
          ) : (
            <ul className="small">
              {Object.entries(counts.delivery).map(([state, value]) => (
                <li key={state}>
                  {state}：{value}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {channels.failing.length > 0 ? (
        <section className="card">
          <h2>频道错误</h2>
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
        </section>
      ) : null}

      {status.recentFailedJobs.length > 0 ? (
        <section className="card">
          <h2>最近失败任务</h2>
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
        </section>
      ) : null}
    </div>
  );
}
