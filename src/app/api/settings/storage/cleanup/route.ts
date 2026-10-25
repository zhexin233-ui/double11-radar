import { z } from "zod";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import { cleanupExpiredBulletins } from "@/lib/service/storage";

const CleanupInputSchema = z.object({
  retentionDays: z.number().int().min(0).max(3650).optional(),
  cleanOnlyUnmatched: z.boolean().optional(),
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const rawBody = await req.json().catch(() => ({}));
  const parsed = CleanupInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError("INVALID_BODY", "清理参数不合法", 400);
  }

  const result = cleanupExpiredBulletins(db, {
    retentionDays: parsed.data.retentionDays,
    cleanOnlyUnmatched: parsed.data.cleanOnlyUnmatched,
  });

  return ok(result);
});
