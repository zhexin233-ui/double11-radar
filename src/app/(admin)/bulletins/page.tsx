"use client";

import Link from "next/link";
import { useApiResource } from "@/components/use-api";
import {
  STATUS_LABELS,
  type BulletinDetailDto,
} from "@/components/api-types";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

interface BulletinsResponse {
  items: BulletinDetailDto[];
  total: number;
}

export default function BulletinsPage() {
  const { data, error, loading, reload } = useApiResource<BulletinsResponse>(
    "/api/bulletins?limit=50",
    { refreshMs: 30000 },
  );

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>线报记录</h1>
        <button type="button" className="ghost" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      <p className="muted small">
        只显示已过基线的线报。状态区分「明确匹配」「待确认（信息不足）」「处理失败」与「没有匹配」；
        「处理失败」是模型或调用异常，不代表没有命中。
      </p>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">正在加载…</p> : null}

      <section className="card">
        {data && data.items.length === 0 ? (
          <p className="muted">
            暂无记录。首次启动会先建立基线，只处理之后出现的新线报。
          </p>
        ) : null}
        {data && data.items.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>线报</th>
                <th>命中需求</th>
                <th>价格</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.bulletin.id}>
                  <td>
                    <span className={`badge ${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </td>
                  <td>
                    <Link href={`/bulletins/${item.bulletin.id}`}>
                      {item.bulletin.title}
                    </Link>
                    <div className="muted small">
                      {item.bulletin.sourceNs}
                      {item.bulletin.category ? ` · ${item.bulletin.category}` : ""}
                    </div>
                  </td>
                  <td className="small">
                    {item.matchedNeeds.length ? item.matchedNeeds.join("、") : "—"}
                  </td>
                  <td className="small">
                    {item.bulletin.price === null ? "" : `${item.bulletin.price} 元`}
                  </td>
                  <td className="small">{formatTime(item.bulletin.publishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {data && data.total > data.items.length ? (
          <p className="muted small">
            共 {data.total} 条，当前显示最近 {data.items.length} 条。
          </p>
        ) : null}
      </section>
    </div>
  );
}
