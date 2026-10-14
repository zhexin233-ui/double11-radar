import {
  channelStats,
  getChannelSelection,
  listChannels,
} from "@/lib/db/repos/channels";
import { syncChannels } from "@/lib/service/config";
import { fetchMeta } from "@/lib/sources/xianbao/client";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { getDatabase, getEnv, requireAuth } from "@/lib/http/server";

/** 手动刷新官方能力清单（单次操作，不触发历史回放）。 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  requireAuth(req);
  const db = getDatabase();
  const env = getEnv();
  try {
    const meta = await fetchMeta({ baseUrl: env.xianbaoApiBase });
    syncChannels(db, meta.channels);
    return ok({
      channels: listChannels(db),
      selection: getChannelSelection(db),
      stats: channelStats(db),
      cacheTtlSeconds: meta.cacheTtlSeconds,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError("META_FETCH_FAILED", `刷新频道清单失败：${message}`, 502);
  }
});
