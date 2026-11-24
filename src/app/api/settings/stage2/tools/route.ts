import { z } from "zod";
import {
  createExternalStage2Tool,
  listStage2ToolsWithSecrets,
} from "@/lib/service/stage2-tools";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const SecretInputSchema = z.union([
  z.string().max(1000),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const CreateSchema = z.object({
  name: z.string().trim().min(1, "工具插件名称不能为空").max(100),
  kind: z.enum(["mcp", "http_api"]),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  config: z.record(z.string(), z.unknown()),
  failureThreshold: z.number().int().min(1).max(20).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  secret: SecretInputSchema.optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  return ok({ tools: listStage2ToolsWithSecrets(db) });
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidBodyError(parsed.error);
  }
  const tool = createExternalStage2Tool(db, parsed.data);
  return ok({ tool }, { status: 201 });
});
