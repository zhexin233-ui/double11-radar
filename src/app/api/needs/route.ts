import { z } from "zod";
import { createNeed, listNeeds } from "@/lib/db/repos/needs";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const CreateSchema = z.object({
  name: z.string().trim().min(1, "需求名称不能为空").max(100),
  note: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
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
    throw new HttpError("INVALID_BODY", body.error.issues[0]?.message ?? "请求不合法", 400);
  }
  const need = createNeed(db, {
    name: body.data.name,
    note: body.data.note ?? "",
    enabled: body.data.enabled ?? true,
  });
  return ok({ need }, { status: 201 });
});
