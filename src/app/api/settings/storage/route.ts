import { z } from "zod";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import {
  getStorageSettings,
  getStorageStats,
  saveStorageSettings,
} from "@/lib/service/storage";

const StorageSettingsPatchSchema = z.object({
  retentionDays: z.number().int().min(0).max(3650).optional(),
  autoCleanupEnabled: z.boolean().optional(),
  cleanOnlyUnmatched: z.boolean().optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const settings = getStorageSettings(db);
  const stats = getStorageStats(db);
  return ok({ settings, stats });
});

export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = StorageSettingsPatchSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "存储设置格式不正确", 400);
  }
  const updated = saveStorageSettings(db, body.data);
  const stats = getStorageStats(db);
  return ok({ settings: updated, stats });
});
