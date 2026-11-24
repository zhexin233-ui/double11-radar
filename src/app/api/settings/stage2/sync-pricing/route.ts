import { handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import {
  getStage2EffectivePricingSummary,
  syncOpenRouterCatalog,
} from "@/lib/service/openrouter-pricing";
import { getStage2Config } from "@/lib/service/stage2-config";

/**
 * 手动触发 OpenRouter 公开模型价格目录同步。
 * 复用与 worker 相同的跨进程刷新占位锁，避免并发重叠写入。
 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);

  const result = await syncOpenRouterCatalog(db, { force: true });
  const { config } = getStage2Config(db);
  const pricing = getStage2EffectivePricingSummary(db, config.llm);

  return ok({
    synced: result.synced,
    skippedReason: result.skippedReason ?? null,
    modelCount: result.modelCount,
    error: result.error,
    pricing,
  });
});
