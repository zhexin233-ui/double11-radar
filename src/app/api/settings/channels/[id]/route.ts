import { z } from "zod";
import { HttpError, invalidBodyError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import {
  editChannel,
  removeChannel,
  activateChannel,
} from "@/lib/service/model-channels";

type Ctx = { params: Promise<{ id: string }> };

const ChannelUpdateSchema = z.object({
  name: z.string().trim().min(1, "渠道名称不能为空").max(100).optional(),
  baseUrl: z.string().trim().url("服务地址必须是合法 URL").max(500).optional(),
  model: z.string().trim().min(1, "模型名称不能为空").max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

export const PUT = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const body = ChannelUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }

  const updated = editChannel(db, { id, ...body.data });
  if (!updated) {
    throw new HttpError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
  }
  return ok(updated);
});

export const DELETE = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const res = removeChannel(db, id);
  if (!res.deleted) {
    throw new HttpError("CHANNEL_DELETE_FAILED", res.reason ?? "删除失败", 400);
  }
  return ok({ deleted: true });
});

export const POST = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const activated = activateChannel(db, id);
  if (!activated) {
    throw new HttpError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
  }
  return ok(activated);
});
