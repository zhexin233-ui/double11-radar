import { z } from "zod";
import {
  getStage2Config,
  updateStage2Config,
} from "@/lib/service/stage2-config";
import { listStage2ToolsWithSecrets } from "@/lib/service/stage2-tools";
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

const PutSchema = z.object({
  enabled: z.boolean().optional(),
  includeUncertain: z.boolean().optional(),
  notifyOnInsufficientInfo: z.boolean().optional(),
  fallbackToStage1Notify: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(4).optional(),
  llm: z
    .object({
      baseUrl: z.string().trim().min(1).max(500).optional(),
      model: z.string().trim().min(1).max(200).optional(),
      timeoutMs: z.number().int().min(3000).max(120000).optional(),
      maxSteps: z.number().int().min(1).max(8).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
  apiKey: SecretInputSchema.optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const snapshot = getStage2Config(db);
  const tools = listStage2ToolsWithSecrets(db);
  return ok({
    ...snapshot,
    tools,
  });
});

export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidBodyError(parsed.error);
  }
  const snapshot = updateStage2Config(db, parsed.data);
  const tools = listStage2ToolsWithSecrets(db);
  return ok({
    ...snapshot,
    tools,
  });
});
