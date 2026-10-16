import {
  MAX_REGEX_RULES,
  MAX_REGEX_RULE_LENGTH,
  MAX_REGEX_TOTAL_BYTES,
} from "@/lib/domain/constants";

/**
 * 全局正则规则的纯函数部分：输入归一化、结构校验与匹配文本构造。
 *
 * 约定（与设计契约一致）：
 * - 一行一条 JS 正则 source（不带首尾斜杠、不接受自定义 flags），固定 `iu`；
 * - 纯空白行忽略；非空行保留原空格；精确去重且保留顺序；
 * - 上限 20 条 / 每条 500 UTF-16 单元 / 合计 16 KiB。
 *
 * 语法编译与执行在独立线程（`regex-runner.ts` / `matcher.mjs`）完成，
 * 这里不做 `new RegExp`，避免在主线程同步执行用户规则。
 */

export type RegexRulesParse =
  | { ok: true; rules: string[] }
  | { ok: false; error: string };

/** 把表单提交的原始行（数组或整段文本）归一化为规则列表。 */
export function parseRegexRules(raw: unknown): RegexRulesParse {
  let lines: string[];
  if (typeof raw === "string") {
    lines = raw.split(/\r?\n/);
  } else if (Array.isArray(raw)) {
    if (!raw.every((line) => typeof line === "string")) {
      return { ok: false, error: "正则规则必须是文本行" };
    }
    lines = raw as string[];
  } else {
    return { ok: false, error: "正则规则必须是文本或文本数组" };
  }

  const rules: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    // 纯空白行忽略；其它行原样保留（非空内容中的空格不裁剪）。
    if (line.trim() === "") continue;
    if (seen.has(line)) continue;
    seen.add(line);
    rules.push(line);
  }
  return { ok: true, rules };
}

export type RegexRuleValidation = { ok: true } | { ok: false; error: string };

/** 结构校验：条数、单条长度与总体积。 */
export function validateRegexRuleShape(
  rules: readonly string[],
): RegexRuleValidation {
  if (rules.length > MAX_REGEX_RULES) {
    return { ok: false, error: `正则规则最多 ${MAX_REGEX_RULES} 条` };
  }
  let totalBytes = 0;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.length > MAX_REGEX_RULE_LENGTH) {
      return {
        ok: false,
        error: `第 ${index + 1} 条规则超过 ${MAX_REGEX_RULE_LENGTH} 个字符`,
      };
    }
    totalBytes += Buffer.byteLength(rule, "utf8");
  }
  if (totalBytes > MAX_REGEX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `正则规则总长度超过 ${Math.floor(MAX_REGEX_TOTAL_BYTES / 1024)} KiB`,
    };
  }
  return { ok: true };
}

export interface RegexMatchFields {
  title: string;
  content?: string | null;
  category?: string | null;
  brand?: string | null;
  mall?: string | null;
  price?: number | null;
}

/**
 * 构造带中文标签的匹配文本：标题、正文及现有品类/品牌/商城/来源价格。
 * 字段顺序固定，缺失字段省略；数值只按现有来源值作为文本，不宣称券后实付。
 */
export function buildRegexMatchText(fields: RegexMatchFields): string {
  const parts: string[] = [`标题：${fields.title}`];
  if (fields.content) parts.push(`正文：${fields.content}`);
  if (fields.category) parts.push(`品类：${fields.category}`);
  if (fields.brand) parts.push(`品牌：${fields.brand}`);
  if (fields.mall) parts.push(`商城：${fields.mall}`);
  if (fields.price !== null && fields.price !== undefined) {
    parts.push(`来源价格：${fields.price}`);
  }
  return parts.join("\n");
}
