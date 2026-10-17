/**
 * 分页查询参数解析的唯一入口（纯函数，便于单测）。
 *
 * 规则：非法输入一律回退到安全值，绝不抛出导致 500；
 * `limit` 至少为 1、至多 `maxLimit`；`offset` 至少为 0。
 */

/** 解析整数查询参数；`null` / 空串 / 非整数回退默认值。 */
export function parseIntegerParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/** 把页大小夹取到 `[1, max]`；非有限值回退为 1。 */
export function clampLimit(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * 解析 `limit` / `offset`。缺省或非法 `limit` 用 `defaultLimit`，
 * 超过 `maxLimit` 夹取；`offset` 缺省或非法为 0，负数归零。
 */
export function parsePageQuery(
  params: URLSearchParams,
  options: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number } {
  const limit = clampLimit(
    parseIntegerParam(params.get("limit"), options.defaultLimit),
    options.maxLimit,
  );
  const offset = Math.max(parseIntegerParam(params.get("offset"), 0), 0);
  return { limit, offset };
}
