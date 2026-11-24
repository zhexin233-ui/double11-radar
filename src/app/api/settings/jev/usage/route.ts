import type { UsageStageScope } from "@/lib/domain/types";
import { getJevUsageView } from "@/lib/service/jev-usage";
import { getChannels } from "@/lib/service/model-channels";
import { HttpError, handleRoute, ok } from "@/lib/http/json";
import { parsePageQuery } from "@/lib/http/query";
import { requireAuth } from "@/lib/http/server";

const VALID_STAGES = new Set<UsageStageScope>(["all", "stage1", "stage2"]);

/**
 * 一级与二级核验费用与用量统计。
 *
 * - 省略 `stage` 时保持兼容 `stage1`；费用页默认请求 `all`；
 * - `all` / `stage2` 视图下忽略 `channelId` / `baseUrl`；
 * - 只返回清洗后的非敏感字段；金额为估算值，未知用量单独计数。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const pageQuery = parsePageQuery(url.searchParams, {
    defaultLimit: 20,
    maxLimit: 200,
  });

  const rawStage = url.searchParams.get("stage")?.trim();
  let stage: UsageStageScope = "stage1";
  if (rawStage) {
    if (!VALID_STAGES.has(rawStage as UsageStageScope)) {
      throw new HttpError(
        "INVALID_STAGE",
        "核验级别参数不合法，仅支持 all、stage1、stage2",
        400,
      );
    }
    stage = rawStage as UsageStageScope;
  }

  const model = url.searchParams.get("model")?.trim() || undefined;
  const channelId =
    stage === "stage1"
      ? url.searchParams.get("channelId")?.trim() || undefined
      : undefined;
  const baseUrl =
    stage === "stage1"
      ? url.searchParams.get("baseUrl")?.trim() || undefined
      : undefined;

  const usage = getJevUsageView(db, {
    ...pageQuery,
    stage,
    model,
    channelId,
    baseUrl,
  });
  const channels = getChannels(db);
  return ok({ ...usage, channels });
});
