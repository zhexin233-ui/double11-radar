import { createHash } from "node:crypto";

/**
 * Jev 问题模板与判定规则版本。
 * 判断记录按该版本复用；模板语义变化时必须提升版本号。
 */
export const RULE_VERSION = "systemone-choice-v1";

/** 线报来源标识（当前仅线报酷）。 */
export const XIANBAO_SOURCE = "xianbao";

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = "xianbao_session";

/** 会话有效期：7 天（毫秒）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 登录失败限速：连续失败次数达到该值即锁定。 */
export const LOGIN_MAX_FAILURES = 5;

/** 登录失败锁定时间：5 分钟（毫秒）。 */
export const LOGIN_LOCK_MS = 5 * 60 * 1000;

/** 计算线报内容版本：title|content|category|price|brand|mall 的 sha256 前 16 位。 */
export function contentVersion(input: {
  title: string;
  content?: string | null;
  category?: string | null;
  price?: number | null;
  brand?: string | null;
  mall?: string | null;
}): string {
  const raw = [
    input.title ?? "",
    input.content ?? "",
    input.category ?? "",
    input.price === null || input.price === undefined ? "" : String(input.price),
    input.brand ?? "",
    input.mall ?? "",
  ].join("|");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}
