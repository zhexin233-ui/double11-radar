import { z } from "zod";
import {
  getJevConfigView,
  saveJevConfig,
  type SecretInput,
} from "@/lib/service/config";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const SecretInputSchema = z.union([
  z.string().max(500),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const PutSchema = z.object({
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  apiKey: SecretInputSchema.optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  return ok(getJevConfigView(db));
});

export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = PutSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "Jev 配置不合法", 400);
  }
  const view = saveJevConfig(db, {
    baseUrl: body.data.baseUrl,
    model: body.data.model,
    timeoutMs: body.data.timeoutMs,
    apiKey: body.data.apiKey as SecretInput,
  });
  return ok(view);
});
