import { z } from "zod";
import {
  getNotifyConfigView,
  saveNotifyConfig,
  type SecretInput,
} from "@/lib/service/config";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const SecretInputSchema = z.union([
  z.string().max(1000),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const PutSchema = z.object({
  bark: z
    .object({
      enabled: z.boolean().optional(),
      serverUrl: z.string().url().max(500).optional(),
      deviceKey: SecretInputSchema.optional(),
    })
    .optional(),
  feishu: z
    .object({
      enabled: z.boolean().optional(),
      keywordPrefix: z.string().max(100).optional(),
      signingEnabled: z.boolean().optional(),
      webhook: SecretInputSchema.optional(),
      signingSecret: SecretInputSchema.optional(),
    })
    .optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  return ok(getNotifyConfigView(db));
});

export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = PutSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "推送渠道配置不合法", 400);
  }
  const view = saveNotifyConfig(db, {
    bark: body.data.bark
      ? {
          enabled: body.data.bark.enabled,
          serverUrl: body.data.bark.serverUrl,
          deviceKey: body.data.bark.deviceKey as SecretInput,
        }
      : undefined,
    feishu: body.data.feishu
      ? {
          enabled: body.data.feishu.enabled,
          keywordPrefix: body.data.feishu.keywordPrefix,
          signingEnabled: body.data.feishu.signingEnabled,
          webhook: body.data.feishu.webhook as SecretInput,
          signingSecret: body.data.feishu.signingSecret as SecretInput,
        }
      : undefined,
  });
  return ok(view);
});
