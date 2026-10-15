import { z } from "zod";
import { removeJevKey, updateJevKeySettings } from "@/lib/service/jev-keys";
import type { SecretInput } from "@/lib/service/config";
import { HttpError, handleRoute, invalidBodyError, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 修改或删除单个 Jev API Key。
 *
 * - `label`：重命名；
 * - `enabled`：启停；显式 `true` 表示手动恢复（清零失败计数并进入新 generation）；
 * - `apiKey`：三态语义（字符串=替换、`{clear:true}`=清除、空/null/缺省=保留）；
 *   替换与恢复都不改变彼此的语义，清除会同时停用该 Key；
 * - `DELETE`：删除该 Key 与其密文，历史调用账本保留非敏感快照。
 */
type Ctx = { params: Promise<{ id: string }> };

const SecretInputSchema = z.union([
  z.string().max(500),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const PatchSchema = z.object({
  label: z
    .string({ error: "Key 名称必须是文本" })
    .trim()
    .min(1, "Key 名称不能为空")
    .max(100, "Key 名称过长（最多 100 字）")
    .optional(),
  enabled: z.boolean({ error: "启用状态必须是布尔值" }).optional(),
  apiKey: SecretInputSchema.optional(),
});

export const PATCH = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw invalidBodyError(body.error);

  const updated = updateJevKeySettings(
    db,
    id,
    {
      label: body.data.label,
      enabled: body.data.enabled,
      apiKey: body.data.apiKey as SecretInput,
    },
  );
  if (!updated) throw new HttpError("NOT_FOUND", "该 Jev 密钥不存在", 404);
  return ok(updated);
});

export const DELETE = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const removed = removeJevKey(db, id);
  if (!removed) throw new HttpError("NOT_FOUND", "该 Jev 密钥不存在", 404);
  return ok({ id, removed: true });
});
