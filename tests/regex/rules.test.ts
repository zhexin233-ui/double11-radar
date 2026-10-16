import { describe, expect, it } from "vitest";
import {
  buildRegexMatchText,
  parseRegexRules,
  validateRegexRuleShape,
} from "@/lib/regex/rules";
import { createRegexRunner } from "@/lib/service/regex-runner";
import {
  MAX_REGEX_RULE_LENGTH,
  MAX_REGEX_TOTAL_BYTES,
} from "@/lib/domain/constants";

/**
 * 全局正则规则的纯函数与线程执行（AC7/AC8）。
 *
 * 线程测试验证真实 `worker_threads` 生命周期（ready/validate/match/清理）；
 * 常规流程测试使用 fake runner，不依赖毫秒级吞吐断言。
 */

describe("规则归一化（AC7）", () => {
  it("忽略纯空白行、保留非空行内空格、精确去重且保序", () => {
    const parsed = parseRegexRules(["  抽纸 | 软抽 ", "", "   ", "  抽纸 | 软抽 ", "湿巾"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules).toEqual(["  抽纸 | 软抽 ", "湿巾"]);
  });

  it("整段文本按行拆分", () => {
    const parsed = parseRegexRules("a\n\nb\n");
    expect(parsed.ok && parsed.rules).toEqual(["a", "b"]);
  });

  it("非字符串输入被拒绝", () => {
    expect(parseRegexRules([1, 2]).ok).toBe(false);
    expect(parseRegexRules(42).ok).toBe(false);
  });

  it("条数/单条长度/总体积上限（AC8）", () => {
    expect(validateRegexRuleShape(Array.from({ length: 21 }, () => "a")).ok).toBe(false);
    expect(
      validateRegexRuleShape(["a".repeat(MAX_REGEX_RULE_LENGTH + 1)]).ok,
    ).toBe(false);
    expect(
      validateRegexRuleShape(["a".repeat(MAX_REGEX_TOTAL_BYTES + 1)]).ok,
    ).toBe(false);
    expect(validateRegexRuleShape(["抽纸"]).ok).toBe(true);
  });
});

describe("匹配文本构造（AC7）", () => {
  it("带中文标签并按固定顺序拼接，缺失字段省略，价格只按来源值", () => {
    const text = buildRegexMatchText({
      title: "心相印抽纸",
      content: "9.9 包邮",
      category: "日用",
      brand: null,
      mall: "天猫",
      price: 9.9,
    });
    expect(text).toBe(
      ["标题：心相印抽纸", "正文：9.9 包邮", "品类：日用", "商城：天猫", "来源价格：9.9"].join(
        "\n",
      ),
    );
    expect(text).not.toContain("品牌");
  });

  it("缺价格时不写出价格字段（null 不当作 0）", () => {
    const text = buildRegexMatchText({ title: "标题", price: null });
    expect(text).toBe("标题：标题");
  });
});

describe("线程执行（AC8）", () => {
  it("真实 worker 完成 validate / match / 清理", async () => {
    const runner = createRegexRunner();
    try {
      const valid = await runner.validate(["抽纸|软抽"]);
      expect(valid.ok).toBe(true);

      const matched = await runner.match(["抽纸|软抽"], "标题：心相印抽纸 24包");
      expect(matched).toEqual({ ok: true, matched: true, matchedRuleIndex: 0 });

      const filtered = await runner.match(["抽纸|软抽"], "标题：洗衣液");
      expect(filtered).toEqual({ ok: true, matched: false, matchedRuleIndex: null });
    } finally {
      runner.dispose();
    }
  });

  it("非法规则语法返回错误（保存预检用），不抛未处理异常", async () => {
    const runner = createRegexRunner();
    try {
      const invalid = await runner.validate(["(未闭合"]);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error.length).toBeGreaterThan(0);
    } finally {
      runner.dispose();
    }
  });

  it("超过文本上限直接 fallback，不截断后过滤", async () => {
    const runner = createRegexRunner();
    try {
      const result = await runner.match(["抽纸"], "x".repeat(70_000));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fallback).toBe(true);
    } finally {
      runner.dispose();
    }
  });
});
