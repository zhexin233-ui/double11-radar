import { getBulletin } from "@/lib/db/repos/bulletins";
import { describeBulletin } from "@/lib/service/bulletins";
import { HttpError, handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

type Ctx = { params: Promise<{ id: string }> };

/** 线报详情：原始标题/链接、每个需求的 Choice 结果、概率/置信度与投递状态。 */
export const GET = handleRoute<Ctx>(async (req, ctx) => {
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const bulletin = getBulletin(db, id);
  if (!bulletin) {
    throw new HttpError("NOT_FOUND", "线报不存在", 404);
  }
  return ok(describeBulletin(db, bulletin));
});
