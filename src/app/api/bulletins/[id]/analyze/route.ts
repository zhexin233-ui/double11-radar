import { getBulletin } from "@/lib/db/repos/bulletins";
import { analyzeBulletinOnce } from "@/lib/worker/analyzer";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;

  const bulletin = getBulletin(db, id);
  if (!bulletin) {
    throw new HttpError("NOT_FOUND", "线报不存在", 404);
  }

  const analysis = await analyzeBulletinOnce(db, bulletin, {
    triggerSource: "manual",
  });
  return ok({ analysis });
});
