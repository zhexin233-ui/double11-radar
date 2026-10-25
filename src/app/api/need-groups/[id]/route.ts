import { z } from "zod";
import {
  deleteNeedGroup,
  getNeedGroup,
  updateNeedGroup,
} from "@/lib/db/repos/need-groups";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const UpdateGroupSchema = z
  .object({
    name: z
      .string({ error: "分组名称必须是文本" })
      .trim()
      .min(1, "分组名称不能为空")
      .max(100, "分组名称过长（最多 100 字）")
      .optional(),
    enabled: z.boolean({ error: "enabled 必须是布尔值" }).optional(),
    orderNum: z.number({ error: "orderNum 必须是数字" }).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "至少提供一个要更新的字段",
  });

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const body = UpdateGroupSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }
  const group = updateNeedGroup(db, id, body.data);
  if (!group) {
    throw new HttpError("NOT_FOUND", "分组不存在", 404);
  }
  return ok({ group });
});

export const DELETE = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  if (!getNeedGroup(db, id)) {
    throw new HttpError("NOT_FOUND", "分组不存在", 404);
  }
  deleteNeedGroup(db, id);
  return ok({ deleted: true });
});
