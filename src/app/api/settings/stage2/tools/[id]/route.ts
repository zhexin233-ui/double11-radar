import { z } from "zod";
import {
  deleteStage2ToolService,
  updateStage2ToolService,
} from "@/lib/service/stage2-tools";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

type Ctx = { params: Promise<{ id: string }> };

const SecretInputSchema = z.union([
  z.string().max(1000),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  failureThreshold: z.number().int().min(1).max(20).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  secret: SecretInputSchema.optional(),
  resetCircuit: z.boolean().optional(),
});

export const PUT = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidBodyError(parsed.error);
  }

  const tool = updateStage2ToolService(db, id, parsed.data);
  return ok({ tool });
});

export const DELETE = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  deleteStage2ToolService(db, id);
  return ok({ deleted: true });
});
