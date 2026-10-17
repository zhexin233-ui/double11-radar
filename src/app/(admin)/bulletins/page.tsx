"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button, Select, Switch } from "@mantine/core";
import { useApiResource } from "@/components/use-api";
import {
  BULLETIN_AUTO_REFRESH_MS,
  BULLETIN_FILTER_OPTIONS,
  BULLETIN_PAGE_SIZE,
  PROCESSING_SOURCE_LABELS,
  STATUS_LABELS,
  type BulletinDetailDto,
  type BulletinFilterStatusDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { List, ListItem, Eyebrow } from "@/components/ui/List";
import { Pagination } from "@/components/ui/Pagination";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";
import { clampPage } from "@/components/pagination-model";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

interface BulletinsResponse {
  items: BulletinDetailDto[];
  total: number;
}

/** 把下拉的字符串收窄成筛选枚举，避免对 API 响应做断言。 */
function isFilterStatus(value: string): value is BulletinFilterStatusDto {
  return BULLETIN_FILTER_OPTIONS.some((option) => option.value === value);
}

/** Mantine `Select` 用非空字符串更省心，「全部」映射成哨兵值 `all`。 */
const FILTER_DATA = BULLETIN_FILTER_OPTIONS.map((option) => ({
  value: option.value || "all",
  label: option.label,
}));

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

  // 数据缩减（例如筛选后的记录被清理）导致页码越界时，在渲染期收敛到最后一个有效页。
  // 用「比较后修正 state」而不是 useEffect（react-hooks/set-state-in-effect），
  // 且修正只在越界的那一次渲染发生，条件随后不再成立。
  const total = data?.total ?? null;
  if (total !== null) {
    const clamped = clampPage(page, total, BULLETIN_PAGE_SIZE);
    if (clamped !== page) setPage(clamped);
  }
  // 派生当前有效页码用于展示；越界时与修正后的 page 一致。
  const safePage = total === null ? page : clampPage(page, total, BULLETIN_PAGE_SIZE);

  return (
    <div className="page">
      <PageHeader
        title="线报记录"
        lead="只显示已过基线的线报，按状态区分「明确匹配」「待确认（信息不足）」「处理失败」与「没有匹配」；「处理失败」是模型或调用异常，不代表没有命中。"
      />

      <Section>
        <div className="toolbar" style={{ marginBottom: "var(--sp-5)" }}>
          <div className="toolbar-start">
            <Select
              id="status-filter"
              label="状态筛选"
              size="sm"
              data={FILTER_DATA}
              value={status || "all"}
              onChange={(next) => {
                if (next === null) return;
                if (next === "all") {
                  setStatus("");
                  setPage(0);
                  return;
                }
                if (isFilterStatus(next)) {
                  setStatus(next);
                  setPage(0);
                }
              }}
              allowDeselect={false}
            />
          </div>
          <div className="toolbar-end">
            <Button variant="default" size="sm" onClick={() => void reload()}>
              刷新
            </Button>
            <Switch
              size="sm"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
              label="自动刷新（5 秒）"
            />
          </div>
        </div>

        {error ? <Feedback kind="error">加载失败：{error}</Feedback> : null}
        {loading && !data ? <Feedback kind="loading">正在加载…</Feedback> : null}

        {data && data.items.length === 0 ? (
          <p className="empty">
            {status
              ? "当前筛选下没有记录，可切换其它状态查看。"
              : "暂无记录。首次启动会先建立基线，只处理之后出现的新线报。"}
          </p>
        ) : null}

        {data && data.items.length > 0 ? (
          <List>
            {data.items.map((item) => {
              const eyebrowItems: ReactNode[] = [
                <StatusBadge key="status" status={item.status}>
                  {STATUS_LABELS[item.status]}
                </StatusBadge>,
                item.bulletin.sourceNs,
              ];
              if (item.bulletin.category) eyebrowItems.push(item.bulletin.category);
              eyebrowItems.push(formatTime(item.bulletin.publishedAt));

              const price = item.bulletin.price;

              return (
                <ListItem key={item.bulletin.id}>
                  <div className="list-body">
                    <div>
                      <Eyebrow items={eyebrowItems} />
                      <Link className="list-title" href={`/bulletins/${item.bulletin.id}`}>
                        {item.bulletin.title}
                      </Link>
                      <div className="list-meta">
                        {price === null ? null : <span>价格：{price} 元</span>}
                        <span>
                          命中需求：
                          {item.matchedNeeds.length ? item.matchedNeeds.join("、") : "—"}
                        </span>
                        {item.processing?.screeningSource ? (
                          <span>
                            {PROCESSING_SOURCE_LABELS[item.processing.screeningSource]}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className="list-trailing muted small" aria-hidden="true">
                      查看 →
                    </span>
                  </div>
                </ListItem>
              );
            })}
          </List>
        ) : null}

        {data && data.total > 0 ? (
          <Pagination
            page={safePage}
            total={data.total}
            pageSize={BULLETIN_PAGE_SIZE}
            onPage={setPage}
            unit="条"
          />
        ) : null}
      </Section>
    </div>
  );
}
