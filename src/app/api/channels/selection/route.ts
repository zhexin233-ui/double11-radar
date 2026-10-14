import { z } from "zod";
import {
  applyChannelSelection,
  getChannelSelection,
  listChannels,
  saveChannelSelection,
} from "@/lib/db/repos/channels";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const Schema = z.object({
  mode: z.enum(["all", "custom"]),
  customIds: z.array(z.string().min(1)).max(200).default([]),
});

/** 保存频道选择模式；`all` 跟随能力清单，`custom` 只启用列出的频道。 */
export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "选择模式不合法", 400);
  }
  const selection = {
    mode: body.data.mode,
    customIds: [...new Set(body.data.customIds)],
  };
  saveChannelSelection(db, selection);
  applyChannelSelection(db, selection);
  return ok({ selection: getChannelSelection(db), channels: listChannels(db) });
});
