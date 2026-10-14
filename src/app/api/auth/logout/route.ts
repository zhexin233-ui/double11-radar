import { destroySession, sessionCookieOptions } from "@/lib/auth/session";
import { readSessionToken } from "@/lib/auth/guard";
import { handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { getDatabase, getEnv } from "@/lib/http/server";

/** 退出登录：删除服务端会话并清 Cookie。 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = getDatabase();
  const env = getEnv();
  const token = readSessionToken(req);
  if (token) {
    destroySession(db, token);
  }
  const response = ok({ authenticated: false });
  response.cookies.set("xianbao_session", "", {
    ...sessionCookieOptions(env),
    maxAge: 0,
  });
  return response;
});
