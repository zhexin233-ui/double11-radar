import { z } from "zod";
import {
  createNeedGroup,
  listNeedGroups,
} from "@/lib/db/repos/need-groups";
import { listNeeds } from "@/lib/db/repos/needs";
import {
  invalidBodyError,
  handleRoute,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const CreateGroupSchema = z.object({
  name: z
    .string({ error: "请填写分组名称" })
    .trim()
    .min(1, "分组名称不能为空")
    .max(100, "分组名称过长（最多 100 字）"),
  enabled: z.boolean({ error: "enabled 必须是布尔值" }).optional(),
  orderNum: z.number({ error: "orderNum 必须是数字" }).optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const includeNeeds = url.searchParams.get("includeNeeds") === "true";

  const groups = listNeedGroups(db);
  if (!includeNeeds) {
    return ok({ groups });
  }

  const allNeeds = listNeeds(db);
  const groupsWithNeeds = groups.map((g) => ({
    ...g,
    needs: allNeeds.filter((n) => n.groupId === g.id),
  }));

  return ok({ groups: groupsWithNeeds });
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = CreateGroupSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw invalidBodyError(body.error);
  }
  const group = createNeedGroup(db, {
    name: body.data.name,
    enabled: body.data.enabled ?? true,
    orderNum: body.data.orderNum ?? 0,
  });
  return ok({ group }, { status: 201 });
});
