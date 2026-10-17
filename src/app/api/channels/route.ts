import {
  channelStats,
  getChannelSelection,
  listChannelsPage,
} from "@/lib/db/repos/channels";
import {
  CHANNELS_LIST_DEFAULT_LIMIT,
  CHANNELS_LIST_MAX_LIMIT,
} from "@/lib/domain/constants";
import { handleRoute, ok } from "@/lib/http/json";
import { parsePageQuery } from "@/lib/http/query";
import { requireAuth } from "@/lib/http/server";

/**
 * 频道列表（一页）、选择模式与采集状态概览。
 *
 * 不新增分页 `total` 字段：分页总数复用 `stats.total`（两者都是全部频道数），
 * 避免同一语义出现两个可能漂移的字段。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const url = new URL(req.url);
  const { limit, offset } = parsePageQuery(url.searchParams, {
    defaultLimit: CHANNELS_LIST_DEFAULT_LIMIT,
    maxLimit: CHANNELS_LIST_MAX_LIMIT,
  });
  const { items } = listChannelsPage(db, { limit, offset });
  return ok({
    channels: items,
    selection: getChannelSelection(db),
    stats: channelStats(db),
  });
});
