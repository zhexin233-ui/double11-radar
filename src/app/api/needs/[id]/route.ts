import { z } from "zod";
import { deleteNeed, getNeed, updateNeed } from "@/lib/db/repos/needs";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const UpdateSchema = z
  .object({
    groupId: z.string({ error: "groupId 必须是文本" }).optional(),
    name: z
      .string({ error: "需求名称必须是文本" })
      .trim()
      .min(1, "需求名称不能为空")
      .max(100, "需求名称过长（最多 100 字）")
      .optional(),
    note: z.string({ error: "备注必须是文本" }).max(500, "备注过长（最多 500 字）").optional(),
    enabled: z.boolean({ error: "enabled 必须是布尔值" }).optional(),
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
    throw invalidBodyError(body.error);
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
