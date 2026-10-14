import { listBulletinDetails } from "@/lib/service/bulletins";
import { handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/** 线报记录列表（含判断状态、命中需求与投递状态）。 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "30");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const sourceNs = url.searchParams.get("sourceNs") ?? undefined;
  const page = listBulletinDetails(db, {
    limit: Number.isFinite(limit) ? limit : 30,
    offset: Number.isFinite(offset) ? offset : 0,
    sourceNs: sourceNs || undefined,
    baseline: false,
  });
  return ok(page);
});
