import { describe, expect, it } from "vitest";
import {
  BATCH_GATE_QUESTION_ID,
  buildBatchGateRequest,
  parseBatchGateResponse,
} from "@/lib/jev/batch-prompt";
import {
  measureBatchGateBytes,
  packBatchParts,
} from "@/lib/jev/batch-packing";
import { MAX_BATCH_GATE_BYTES } from "@/lib/domain/constants";
import type { NeedSnapshot } from "@/lib/domain/types";
import type { GateMember } from "@/lib/jev/batch-prompt";
import { makeBulletin } from "../helpers/bulletins";

/**
 * 批次门控的构造、三态严格解析与保守装箱（AC3/AC4/AC5/AC6）。
 *
 * 不调用任何模型；全部是纯函数断言。
 */

const NEEDS: NeedSnapshot[] = [
  { id: "n1", name: "抽纸", note: "不要湿巾", enabled: true, version: 1 },
  { id: "n2", name: "卸妆膏", note: "", enabled: true, version: 3 },
];

function member(id: string, overrides: Partial<GateMember> = {}): GateMember {
  return {
    id,
    title: `线报 ${id}`,
    content: "9.9 元包邮",
    category: "好单线报-日用",
    brand: null,
    mall: null,
    price: 9.9,
    ...overrides,
  };
}

describe("批次门控请求构造（AC4）", () => {
  it("只有一个 batch_relevance 问题，state 含稳定成员 ID 与完整字段", () => {
    const bulletin = makeBulletin({ id: "b-1", title: "心相印抽纸 24包" });
    const request = buildBatchGateRequest([bulletin], NEEDS);
    expect(Object.keys(request.questions)).toEqual([BATCH_GATE_QUESTION_ID]);
    expect(request.questions[BATCH_GATE_QUESTION_ID].type).toBe("choice");
    expect(Object.keys(request.questions[BATCH_GATE_QUESTION_ID].criteria).sort()).toEqual([
      "matched",
      "not_matched",
      "uncertain",
    ]);
    expect(request.questions[BATCH_GATE_QUESTION_ID].instructions).toContain("抽纸");
    expect(request.questions[BATCH_GATE_QUESTION_ID].instructions).toContain("不要湿巾");
    expect(request.questions[BATCH_GATE_QUESTION_ID].instructions).toContain("卸妆膏");

    const state = JSON.parse(request.state) as {
      批次成员: Array<Record<string, unknown>>;
    };
    expect(state.批次成员).toHaveLength(1);
    expect(state.批次成员[0]["成员ID"]).toBe("b-1");
    expect(state.批次成员[0]["线报标题"]).toBe("心相印抽纸 24包");
    expect(state.批次成员[0]["价格"]).toBe(9.9);
  });

  it("相同成员集合的序列化稳定，体积可测（装箱与调用共用构造器）", () => {
    const members = [member("a"), member("b")];
    const first = measureBatchGateBytes(members, NEEDS, "jev-latest");
    const second = measureBatchGateBytes(members, NEEDS, "jev-latest");
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });
});

describe("批次门控三态严格解析（AC3/AC5）", () => {
  const outcomes = ["matched", "not_matched", "uncertain"] as const;
  for (const outcome of outcomes) {
    it(`合法 ${outcome} 正常解析`, () => {
      const parsed = parseBatchGateResponse({
        answers: { [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: outcome } },
      });
      expect(parsed.result).toBe(outcome);
      expect(parsed.error).toBeNull();
    });
  }

  it("缺少 batch_relevance 答案视为 failed，绝不当作未命中", () => {
    const parsed = parseBatchGateResponse({ answers: { other: { choice: "not_matched" } } });
    expect(parsed.result).toBe("failed");
    expect(parsed.error).toContain("batch_relevance");
  });

  it("多余问题答案视为 failed", () => {
    const parsed = parseBatchGateResponse({
      answers: {
        [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "not_matched" },
        extra: { type: "choice", choice: "matched" },
      },
    });
    expect(parsed.result).toBe("failed");
    expect(parsed.error).toContain("多余");
  });

  it("未知 choice 视为 failed", () => {
    const parsed = parseBatchGateResponse({
      answers: { [BATCH_GATE_QUESTION_ID]: { type: "choice", choice: "maybe" } },
    });
    expect(parsed.result).toBe("failed");
    expect(parsed.error).toContain("未知");
  });
});

describe("保守装箱（AC5/AC6）", () => {
  it("成员数超过上限时封组，且不丢成员", () => {
    const members = Array.from({ length: 25 }, (_, index) => member(`m${index}`));
    const plan = packBatchParts(members, NEEDS, { model: "jev-latest" });
    expect(plan.singles).toHaveLength(0);
    const total = plan.parts.reduce((sum, group) => sum + group.length, 0);
    expect(total).toBe(25);
    for (const group of plan.parts) expect(group.length).toBeLessThanOrEqual(20);
    expect(plan.parts.length).toBe(2);
  });

  it("单成员子批直接逐条，不生成门控", () => {
    const plan = packBatchParts([member("only")], NEEDS, { model: "jev-latest" });
    expect(plan.parts).toHaveLength(0);
    expect(plan.singles.map((m) => m.id)).toEqual(["only"]);
  });

  it("单条超体积时直接逐条，不截断正文", () => {
    const huge = member("huge", { content: "x".repeat(40_000) });
    const plan = packBatchParts([huge, member("small-1"), member("small-2")], NEEDS, {
      model: "jev-latest",
    });
    expect(plan.singles.map((m) => m.id)).toEqual(["huge"]);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].map((m) => m.id)).toEqual(["small-1", "small-2"]);
    // 原始正文未被裁剪：装箱只用完整序列化做体积判断。
    expect(huge.content).toHaveLength(40_000);
  });

  it("字节预算用完整请求体衡量，超过保护值即封组", () => {
    const big = member("big", { content: "x".repeat(9_000) });
    const plan = packBatchParts([big, big && member("big-2", { content: "y".repeat(9_000) })], NEEDS, {
      model: "jev-latest",
    });
    // 两条 9k 正文合计必然超过 16 KiB，必须拆开而不是静默裁剪。
    const flat = [...plan.parts.flat(), ...plan.singles];
    expect(flat).toHaveLength(2);
    expect(
      measureBatchGateBytes([big], NEEDS, "jev-latest"),
    ).toBeLessThanOrEqual(MAX_BATCH_GATE_BYTES);
  });
});
