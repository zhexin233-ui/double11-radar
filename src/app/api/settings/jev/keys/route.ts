import { z } from "zod";
import { addJevKey } from "@/lib/service/jev-keys";
import { handleRoute, invalidBodyError, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 新增一个 Jev API Key。
 *
 * 只接受明文密钥用于服务端加密保存；响应只返回掩码状态，绝不回传明文。
 */
const PostSchema = z.object({
  label: z
    .string({ error: "请填写 Key 名称" })
    .trim()
    .min(1, "Key 名称不能为空")
    .max(100, "Key 名称过长（最多 100 字）"),
  apiKey: z
    .string({ error: "请填写 API 密钥" })
    .trim()
    .min(1, "API 密钥不能为空")
    .max(500, "API 密钥过长"),
  channelId: z.string().trim().nullable().optional(),
  baseUrl: z.string().trim().optional(),
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = PostSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw invalidBodyError(body.error);

  // 返回单一视图，便于前端直接渲染；不含明文。
  return ok(
    addJevKey(db, {
      label: body.data.label,
      apiKey: body.data.apiKey,
      channelId: body.data.channelId,
      baseUrl: body.data.baseUrl,
    }),
  );
});
