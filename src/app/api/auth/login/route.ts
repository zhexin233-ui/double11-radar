import { z } from "zod";
import { ensureAdminCredential, verifyPassword } from "@/lib/auth/password";
import {
  clearLoginFailures,
  isLocked,
  recordLoginFailure,
} from "@/lib/auth/guard";
import {
  SESSION_COOKIE,
  createSession,
  generateToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { getClientIp, getDatabase, getEnv } from "@/lib/http/server";

/** 单管理员登录：密码只保存 scrypt 哈希，失败按 IP 限速。 */
const BodySchema = z.object({ password: z.string().min(1) });

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    throw new HttpError("INVALID_BODY", "缺少密码字段", 400);
  }

  const db = getDatabase();
  const env = getEnv();
  const ip = getClientIp(req);

  if (isLocked(db, ip)) {
    throw new HttpError("LOGIN_LOCKED", "登录失败次数过多，请 5 分钟后重试", 429);
  }

  const credential = ensureAdminCredential(db, env);
  if (!verifyPassword(body.data.password, credential)) {
    const { failures, lockedUntil } = recordLoginFailure(db, ip);
    throw new HttpError(
      "INVALID_CREDENTIALS",
      lockedUntil
        ? "密码错误次数过多，已锁定 5 分钟"
        : `密码错误（第 ${failures} 次）`,
      401,
    );
  }

  clearLoginFailures(db, ip);
  const token = generateToken();
  const record = createSession(db, token);
  const response = ok({ authenticated: true, expiresAt: record.expiresAt });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(env));
  return response;
});
