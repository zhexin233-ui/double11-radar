/**
 * 分页纯函数（无 React、无 I/O，便于离线单测）。
 *
 * 约定：`page` 为 0 基页码（0 = 第一页），与 `offset = page * pageSize` 一致。
 * 所有函数都对空集与越界输入做收敛，调用方不必自己兜底。
 */

/** 总页数；空集或非法页大小为 0。 */
export function pageCount(total: number, pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.ceil(total / pageSize);
}

/**
 * 把页码收敛到 `[0, lastPage]`。
 *
 * `total` 缩减（数据被清理 / 筛选变化）时返回最后一个有效页，避免停在空白页；
 * 非整数或负数回退到 0。`total === 0` 返回 0。
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = pageCount(total, pageSize);
  const lastPage = pages === 0 ? 0 : pages - 1;
  const safe = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.min(Math.max(safe, 0), lastPage);
}

/**
 * 当前页显示的条目范围（1 基、闭区间）。
 *
 * 空集返回 `{ start: 0, end: 0 }`；否则 `start = page * pageSize + 1`，
 * `end` 不超过 `total`。与 `offset = (start - 1)` 一致。
 */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { start: number; end: number } {
  if (!Number.isFinite(total) || total <= 0) return { start: 0, end: 0 };
  const safePage = clampPage(page, total, pageSize);
  const start = safePage * pageSize + 1;
  const end = Math.min(start + pageSize - 1, total);
  return { start, end };
}
