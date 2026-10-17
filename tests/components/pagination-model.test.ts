import { describe, expect, it } from "vitest";
import {
  clampPage,
  pageCount,
  pageRange,
  pageSlice,
} from "@/components/pagination-model";

describe("分页纯函数（越界收敛 / 范围计算）", () => {
  it("pageCount：空集 0、整除、有余数、非法页大小", () => {
    expect(pageCount(0, 10)).toBe(0);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(20, 10)).toBe(2);
    expect(pageCount(21, 10)).toBe(3);
    expect(pageCount(5, 0)).toBe(0);
    expect(pageCount(-5, 10)).toBe(0);
  });

  it("clampPage：首页、末页、越界夹取、total 缩减、非法输入", () => {
    expect(clampPage(0, 25, 10)).toBe(0);
    expect(clampPage(2, 25, 10)).toBe(2);
    expect(clampPage(9, 25, 10)).toBe(2);
    // total 缩减后收敛到最后一个有效页（不停在空白页）
    expect(clampPage(2, 5, 10)).toBe(0);
    expect(clampPage(99, 0, 10)).toBe(0);
    expect(clampPage(-4, 25, 10)).toBe(0);
    expect(clampPage(1.9, 25, 10)).toBe(1);
    expect(clampPage(Number.NaN, 25, 10)).toBe(0);
  });

  it("pageRange：首页、末页部分填充、空集、与 offset 一致", () => {
    expect(pageRange(0, 10, 25)).toEqual({ start: 1, end: 10 });
    expect(pageRange(2, 10, 25)).toEqual({ start: 21, end: 25 });
    expect(pageRange(0, 10, 0)).toEqual({ start: 0, end: 0 });

    // start - 1 必须等于该页的 offset
    const range = pageRange(1, 10, 25);
    expect(range.start - 1).toBe(10);
    expect(range).toEqual({ start: 11, end: 20 });

    // 越界页码用收敛后的范围，不产生超出 total 的 end
    expect(pageRange(9, 10, 25)).toEqual({ start: 21, end: 25 });
  });

  it("pageSlice：空集、整除、末页不满、越界页码、非法页大小、total 缩减", () => {
    const items = Array.from({ length: 25 }, (_, index) => index + 1);

    // 空集永远返回空数组，不抛错
    expect(pageSlice([], 0, 10)).toEqual([]);

    // 整除：两页各 10 条
    expect(pageSlice(items.slice(0, 20), 0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pageSlice(items.slice(0, 20), 1, 10)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);

    // 末页不满：第 3 页只有 5 条
    expect(pageSlice(items, 2, 10)).toEqual([21, 22, 23, 24, 25]);

    // 越界页码收敛到末页，而不是返回空
    expect(pageSlice(items, 99, 10)).toEqual([21, 22, 23, 24, 25]);
    expect(pageSlice(items, -3, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // 非法页大小
    expect(pageSlice(items, 0, 0)).toEqual([]);
    expect(pageSlice(items, 0, -10)).toEqual([]);
    expect(pageSlice(items, 0, Number.NaN)).toEqual([]);

    // total 缩减后从末页取到正确切片
    expect(pageSlice(items.slice(0, 5), 2, 10)).toEqual([1, 2, 3, 4, 5]);
  });
});
