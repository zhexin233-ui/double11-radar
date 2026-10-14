import { getSession } from "@/lib/auth/session";
import { readSessionToken } from "@/lib/auth/guard";
import { handleRoute, ok } from "@/lib/http/json";
import { getDatabase } from "@/lib/http/server";

/** 查询当前会话状态（未登录返回 authenticated: false，不报错）。 */
export const GET = handleRoute(async (req) => {
  const db = getDatabase();
  const token = readSessionToken(req);
  const session = token ? getSession(db, token) : null;
  return ok({
    authenticated: session !== null,
    expiresAt: session?.expiresAt ?? null,
  });
});
