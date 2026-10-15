"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useApiResource } from "@/components/use-api";
import {
  BULLETIN_AUTO_REFRESH_MS,
  BULLETIN_FILTER_OPTIONS,
  BULLETIN_PAGE_SIZE,
  STATUS_LABELS,
  type BulletinDetailDto,
  type BulletinFilterStatusDto,
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

/** 把 `<select>` 的字符串收窄成筛选枚举，避免对 API 响应做断言。 */
function isFilterStatus(value: string): value is "" | BulletinFilterStatusDto {
  return BULLETIN_FILTER_OPTIONS.some((option) => option.value === value);
}

export default function BulletinsPage() {
  const [status, setStatus] = useState<"" | BulletinFilterStatusDto>("");
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const offset = page * BULLETIN_PAGE_SIZE;
  const params = new URLSearchParams();
  params.set("limit", String(BULLETIN_PAGE_SIZE));
  params.set("offset", String(offset));
  if (status) params.set("status", status);
  const path = `/api/bulletins?${params.toString()}`;

  const { data, error, loading, reload } = useApiResource<BulletinsResponse>(
    path,
    autoRefresh ? { refreshMs: BULLETIN_AUTO_REFRESH_MS } : {},
  );

  // total 缩减（例如筛选后的数据被清理）时，收敛到最后一个有效页，避免停在空白页。
  // 这是对服务端返回数据的收敛，不是从 props 派生 state。
  useEffect(() => {
    if (!data) return;
    const lastPage =
      data.total === 0 ? 0 : Math.ceil(data.total / BULLETIN_PAGE_SIZE) - 1;
    if (page > lastPage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- total 缩减后回退到有效页，避免展示越界空白页
      setPage(lastPage);
    }
  }, [data, page]);

  const hasNext = data ? offset + data.items.length < data.total : false;

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>线报记录</h1>
        <button type="button" className="ghost" onClick={() => void reload()}>
          刷新
        </button>
        <button
          type="button"
          className="ghost"
          aria-pressed={autoRefresh}
          onClick={() => setAutoRefresh((value) => !value)}
        >
          自动刷新：{autoRefresh ? "开启" : "关闭"}（5 秒）
        </button>
      </div>
      <p className="muted small">
        只显示已过基线的线报。状态区分「明确匹配」「待确认（信息不足）」「处理失败」与「没有匹配」；
        「处理失败」是模型或调用异常，不代表没有命中。自动刷新默认关闭，开启后每 5 秒刷新一次，
        慢请求不会叠加。
      </p>

      <div className="row">
        <label>
          状态筛选
          <select
            value={status}
            onChange={(event) => {
              const next = event.target.value;
              if (!isFilterStatus(next)) return;
              setStatus(next);
              setPage(0);
            }}
          >
            {BULLETIN_FILTER_OPTIONS.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">正在加载…</p> : null}

      <section className="card">
        {data && data.items.length === 0 ? (
          <p className="muted">
            {status
              ? "当前筛选下没有记录，可切换其它状态查看。"
              : "暂无记录。首次启动会先建立基线，只处理之后出现的新线报。"}
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
        {data && data.total > 0 ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted small">
              共 {data.total} 条
              {data.items.length > 0
                ? `，当前显示第 ${offset + 1}–${offset + data.items.length} 条`
                : ""}
            </span>
            <span className="row">
              <button
                type="button"
                className="ghost"
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!hasNext}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
