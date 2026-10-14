import { z } from "zod";
import { sendTestNotification } from "@/lib/notify/dispatch";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const Schema = z.object({ channel: z.enum(["bark", "feishu"]) });

/** 单次渠道测试发送；只使用已保存的服务端配置，不回传明文。 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "请指定要测试的渠道", 400);
  }
  const result = await sendTestNotification(db, body.data.channel);
  return ok(result);
});
