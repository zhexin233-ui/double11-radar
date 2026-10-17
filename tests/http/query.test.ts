import { describe, expect, it } from "vitest";
import {
  clampLimit,
  parseIntegerParam,
  parsePageQuery,
} from "@/lib/http/query";

describe("分页参数解析（非法输入回退，绝不 500）", () => {
  it("parseIntegerParam：null / 空串 / 非整数 / 小数回退默认值", () => {
    expect(parseIntegerParam(null, 10)).toBe(10);
    expect(parseIntegerParam("", 10)).toBe(10);
    expect(parseIntegerParam("   ", 10)).toBe(10);
    expect(parseIntegerParam("abc", 10)).toBe(10);
    expect(parseIntegerParam("2.5", 10)).toBe(10);
    expect(parseIntegerParam("10", 10)).toBe(10);
    expect(parseIntegerParam("-5", 0)).toBe(-5);
  });

  it("clampLimit：最小值 1、上限夹取、小数截断", () => {
    expect(clampLimit(-5, 100)).toBe(1);
    expect(clampLimit(0, 100)).toBe(1);
    expect(clampLimit(1, 100)).toBe(1);
    expect(clampLimit(50, 100)).toBe(50);
    expect(clampLimit(500, 100)).toBe(100);
    expect(clampLimit(20.9, 100)).toBe(20);
    expect(clampLimit(Number.NaN, 100)).toBe(1);
    expect(clampLimit(Number.POSITIVE_INFINITY, 100)).toBe(1);
  });

  it("parsePageQuery：缺省值、非法值回退、负 offset 归零、limit 夹上限", () => {
    const options = { defaultLimit: 20, maxLimit: 200 };

    expect(parsePageQuery(new URLSearchParams(), options)).toEqual({
      limit: 20,
      offset: 0,
    });

    expect(
      parsePageQuery(new URLSearchParams({ limit: "abc", offset: "x" }), options),
    ).toEqual({ limit: 20, offset: 0 });

    expect(
      parsePageQuery(new URLSearchParams({ limit: "5", offset: "-3" }), options),
    ).toEqual({ limit: 5, offset: 0 });

    expect(
      parsePageQuery(new URLSearchParams({ limit: "9999", offset: "40" }), options),
    ).toEqual({ limit: 200, offset: 40 });
  });
});
