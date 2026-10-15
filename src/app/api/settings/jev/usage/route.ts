import { getJevUsageView } from "@/lib/service/jev-usage";
import { handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/** 参数非整数时回退默认值；越界由仓库层统一 clamp。 */
function parseIntegerParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/**
 * Jev 费用与用量统计。
 *
 * 只返回清洗后的非敏感字段；金额为「按公布费率估算」并附统计开始时间，
 * 未知用量单独计数，绝不把不完整汇总标成全部账单。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const usage = getJevUsageView(db, {
    // LIMIT/OFFSET 只接受整数：非法输入必须回退而不是变成 500。
    limit: parseIntegerParam(url.searchParams.get("limit"), 20),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0),
  });
  return ok(usage);
});
