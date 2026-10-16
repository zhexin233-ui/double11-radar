import { createHash } from "node:crypto";

/**
 * Jev 问题模板与判定规则版本。
 * 判断记录按该版本复用；模板语义变化时必须提升版本号。
 */
export const RULE_VERSION = "systemone-choice-v1";

/** 线报来源标识（当前仅线报酷）。 */
export const XIANBAO_SOURCE = "xianbao";

// ── 三模式保护预算（工程保护值，不是官方 Token 换算） ──────────────────────

/** 全局正则规则条数上限。 */
export const MAX_REGEX_RULES = 20;
/** 单条规则 source 的 UTF-16 单元上限。 */
export const MAX_REGEX_RULE_LENGTH = 500;
/** 全部规则文本（UTF-8）合计上限。 */
export const MAX_REGEX_TOTAL_BYTES = 16 * 1024;
/** 单条待匹配文本的 UTF-16 单元上限；超限整体回退，不截断后过滤。 */
export const MAX_REGEX_TEXT_LENGTH = 64 * 1024;
/** 单个正则命令（规则 + 文本）的 UTF-16 输入上限。 */
export const MAX_REGEX_COMMAND_INPUT = 512 * 1024;
/** 正则线程启动到显式 ready 的预算。 */
export const REGEX_READY_TIMEOUT_MS = 2_000;
/** 单次正则命令（编译 + 匹配）预算。 */
export const REGEX_COMMAND_TIMEOUT_MS = 500;
/** 终止线程前等待其空闲的最大时间。 */
export const REGEX_IDLE_WAIT_MS = 100;
/** 单个子批的成员数上限。 */
export const MAX_BATCH_PART_MEMBERS = 20;
/** 单个完整门控请求（UTF-8 序列化）的体积上限。 */
export const MAX_BATCH_GATE_BYTES = 16 * 1024;

/** 会话 Cookie 名。 */
export const SESSION_COOKIE = "xianbao_session";

/** 会话有效期：7 天（毫秒）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 登录失败限速：连续失败次数达到该值即锁定。 */
export const LOGIN_MAX_FAILURES = 5;

/** 登录失败锁定时间：5 分钟（毫秒）。 */
export const LOGIN_LOCK_MS = 5 * 60 * 1000;

/** 计算线报内容版本：title|content|category|price|brand|mall 的 sha256 前 16 位。 */export function contentVersion(input: {
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
