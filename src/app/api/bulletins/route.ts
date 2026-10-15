import {
  listBulletinDetails,
  parseBulletinListQuery,
} from "@/lib/service/bulletins";
import { handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 线报记录列表（含判断状态、命中需求与投递状态）。
 *
 * 支持 `status=pending|matched|uncertain|failed|not_matched`（缺省=全部）、
 * `limit`、`offset`、`sourceNs`；始终排除基线。状态筛选在服务端分页之前执行。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const query = parseBulletinListQuery(url.searchParams);
  return ok(listBulletinDetails(db, query));
});
