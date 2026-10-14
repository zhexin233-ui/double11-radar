import {
  channelStats,
  getChannelSelection,
  listChannels,
} from "@/lib/db/repos/channels";
import { handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/** 频道列表、选择模式与采集状态概览。 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  return ok({
    channels: listChannels(db),
    selection: getChannelSelection(db),
    stats: channelStats(db),
  });
});
