import { z } from "zod";
import { JevError } from "@/lib/jev/client";
import { runJevDryRun } from "@/lib/service/dry-run";
import { HttpError, invalidBodyError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 需求试判（dry-run，仅验收用）。
 *
 * 复用生产链路调真实 Jev，但不写判断记录、不产生通知或投递。
 */
const BodySchema = z.object({
  title: z
    .string({ error: "请填写线报标题" })
    .trim()
    .min(1, "请填写线报标题")
    .max(500, "线报标题过长（最多 500 字）"),
  content: z.string({ error: "正文必须是文本" }).max(5000, "正文过长").optional(),
  category: z.string({ error: "品类必须是文本" }).max(200, "品类过长").optional(),
  brand: z.string({ error: "品牌必须是文本" }).max(200, "品牌过长").optional(),
  mall: z.string({ error: "商城必须是文本" }).max(200, "商城过长").optional(),
  price: z
    .number({ error: "价格必须是数字" })
    .finite("价格必须是有限数字")
    .nonnegative("价格不能为负数")
    .nullable()
    .optional(),
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }

  try {
    const result = await runJevDryRun(db, {
      title: body.data.title,
      content: body.data.content ?? null,
      category: body.data.category ?? null,
      brand: body.data.brand ?? null,
      mall: body.data.mall ?? null,
      price: body.data.price ?? null,
    });
    return ok(result);
  } catch (error) {
    if (error instanceof JevError) {
      // 只回传清洗后的错误信息，不回传上游原始响应或凭据。
      throw new HttpError("JE_DRY_RUN_FAILED", error.message, 502);
    }
    throw error;
  }
});
