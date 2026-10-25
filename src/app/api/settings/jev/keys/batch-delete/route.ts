import { z } from "zod";
import { removeDisabledJevKeys } from "@/lib/service/jev-keys";
import { handleRoute, invalidBodyError, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 批量删除当前全部禁用的 Jev API Key。
 *
 * - 只接受 `{ scope: "disabled" }`，避免误删启用中的 Key；
 * - 服务端在执行时重新判定禁用集合（客户端传来的只是操作意图）；
 * - 单事务完成密文清除、元数据删除，并只推进一次配置版本；
 * - 幂等：没有可删除的禁用 Key 时返回 `{ removedIds: [] }`。
 */
const PostSchema = z.object({
  scope: z.literal("disabled", {
    error: '只支持删除全部禁用的 Key（scope 必须为 "disabled"）',
  }),
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = PostSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw invalidBodyError(body.error);

  return ok({ removedIds: removeDisabledJevKeys(db) });
});
