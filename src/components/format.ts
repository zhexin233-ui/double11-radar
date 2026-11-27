/**
 * 时间格式化工具。
 *
 * 把服务端返回的 ISO 时间字符串转成本地可读文本；`null` / 空值 / 非法值
 * 一律渲染 `—`，避免出现 `Invalid Date` 之类的原始输出。
 */
export function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** 历史简报中的空值或非法分数统一显示为暂无数据。 */
export function formatStarRating(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
    return "暂无数据";
  }
  return `${"★".repeat(score)}${"☆".repeat(5 - score)} ${score}/5`;
}
