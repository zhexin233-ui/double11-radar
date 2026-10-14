import { z } from "zod";
import { createNeed, listNeeds } from "@/lib/db/repos/needs";
import { invalidBodyError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const CreateSchema = z.object({
  name: z
    .string({ error: "请填写需求名称" })
    .trim()
    .min(1, "需求名称不能为空")
    .max(100, "需求名称过长（最多 100 字）"),
  note: z.string({ error: "备注必须是文本" }).max(500, "备注过长（最多 500 字）").optional(),
  enabled: z.boolean({ error: "enabled 必须是布尔值" }).optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  return ok({ items: listNeeds(db) });
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }
  const need = createNeed(db, {
    name: body.data.name,
    note: body.data.note ?? "",
    enabled: body.data.enabled ?? true,
  });
  return ok({ need }, { status: 201 });
});
