import { z } from "zod";
import { HttpError, invalidBodyError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import {
  getChannels,
  addChannel,
  editChannel,
  removeChannel,
  activateChannel,
} from "@/lib/service/model-channels";

const ChannelCreateSchema = z.object({
  name: z.string().trim().min(1, "渠道名称不能为空").max(100, "渠道名称过长"),
  baseUrl: z.string().trim().url("服务地址必须是合法 URL").max(500),
  model: z.string().trim().min(1, "模型名称不能为空").max(100),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  isActive: z.boolean().optional(),
});

const ChannelUpdateSchema = z.object({
  name: z.string().trim().min(1, "渠道名称不能为空").max(100).optional(),
  baseUrl: z.string().trim().url("服务地址必须是合法 URL").max(500).optional(),
  model: z.string().trim().min(1, "模型名称不能为空").max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const channels = getChannels(db);
  return ok(channels);
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = ChannelCreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }

  const channel = addChannel(db, body.data);
  return ok(channel);
});
