import { getJevUsageView } from "@/lib/service/jev-usage";
import { handleRoute, ok } from "@/lib/http/json";
import { parsePageQuery } from "@/lib/http/query";
import { requireAuth } from "@/lib/http/server";

/**
 * Jev 费用与用量统计。
 *
 * 只返回清洗后的非敏感字段；金额为「按公布费率估算」并附统计开始时间，
 * 未知用量单独计数，绝不把不完整汇总标成全部账单。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const usage = getJevUsageView(
    db,
    // LIMIT/OFFSET 只接受整数：非法输入回退而不是变成 500。
    parsePageQuery(url.searchParams, { defaultLimit: 20, maxLimit: 200 }),
  );
  return ok(usage);
});
