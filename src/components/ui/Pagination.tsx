"use client";

import type { ReactNode } from "react";
import { Pagination as MantinePagination } from "@mantine/core";
import { clampPage, pageCount, pageRange } from "@/components/pagination-model";

/**
 * 统一分页条：左侧总数与当前范围，右侧 Mantine `Pagination`。
 *
 * - 纯展示：不 fetch、不改自身的 state；翻页由调用方通过 `onPage` 驱动。
 * - `total === 0` 时不渲染任何内容，空态交给页面自己表达。
 * - 页码变化经 `clampPage` 兜底，越界/收缩的页码不会传递出去。
 */
export function Pagination(props: {
  /** 0 基当前页。 */
  page: number;
  /** 总条数（服务端返回的 total）。 */
  total: number;
  /** 每页条数，与服务端请求一致。 */
  pageSize: number;
  /** 目标页码（0 基）。 */
  onPage: (page: number) => void;
  /** 计量单位，例如「条」「次调用」。 */
  unit?: string;
  /** 追加在总数后的说明，例如「含其它页已选」。 */
  note?: ReactNode;
}) {
  const { page, total, pageSize, onPage, unit = "条", note } = props;
  if (total === 0) return null;

  const safePage = clampPage(page, total, pageSize);
  const pages = pageCount(total, pageSize);
  const { start, end } = pageRange(safePage, pageSize, total);

  return (
    <div className="pagination-bar">
      <p className="pagination-summary">
        共 {total} {unit} · 第 {start}–{end} {unit}
        {note ? <> · {note}</> : null}
      </p>
      <nav aria-label="分页导航">
        <MantinePagination
          size="sm"
          total={pages}
          value={safePage + 1}
          onChange={(next) => onPage(clampPage(next - 1, total, pageSize))}
        />
      </nav>
    </div>
  );
}
