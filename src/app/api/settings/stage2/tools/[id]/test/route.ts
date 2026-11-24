import { getStage2Tool } from "@/lib/db/repos/stage2-tools";
import { probeStage2Tool } from "@/lib/agent/tools/registry";
import { getStage2ToolWithSecret } from "@/lib/service/stage2-tools";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;

  const tool = getStage2Tool(db, id);
  if (!tool) {
    throw new HttpError("TOOL_NOT_FOUND", "工具插件不存在", 404);
  }

  const probe = await probeStage2Tool(db, tool);
  const refreshed = getStage2ToolWithSecret(db, id);
  return ok({
    ...probe,
    tool: refreshed,
  });
});
