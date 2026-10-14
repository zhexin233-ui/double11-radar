import { z } from "zod";
import { deleteNeed, getNeed, updateNeed } from "@/lib/db/repos/needs";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const UpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    note: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一个要更新的字段",
  });

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const body = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", body.error.issues[0]?.message ?? "请求不合法", 400);
  }
  const need = updateNeed(db, id, body.data);
  if (!need) {
    throw new HttpError("NOT_FOUND", "需求不存在", 404);
  }
  return ok({ need });
});

export const DELETE = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  if (!getNeed(db, id)) {
    throw new HttpError("NOT_FOUND", "需求不存在", 404);
  }
  deleteNeed(db, id);
  return ok({ deleted: true });
});
