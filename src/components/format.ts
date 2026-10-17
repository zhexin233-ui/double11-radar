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
