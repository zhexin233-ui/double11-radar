import { describe, expect, it } from "vitest";
import {
  buildQuestions,
  buildState,
  parseAnswer,
  parseAnswers,
  questionIdForNeed,
} from "@/lib/jev/prompt";
import type { Bulletin, Need } from "@/lib/domain/types";

const NEED_A: Need = {
  id: "aaa",
  groupId: "default",
  name: "抽纸",
  note: "不要湿巾",
  enabled: true,
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const NEED_B: Need = {
  id: "bbb",
  groupId: "default",
  name: "咖啡豆",
  note: "",
  enabled: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const BULLETIN: Bulletin = {
  id: "b1",
  source: "xianbao",
  sourceNs: "feed:haodan",
  sourceId: "1",
  url: "https://example.test/1.html",
  title: "心相印超韧抽纸 24包",
  content: "9.9元包邮",
  category: "好单线报-日用-天猫",
  price: 9.9,
  brand: null,
  mall: null,
  publishedAt: "2026-10-14T00:42:00.000Z",
  payload: "{}",
  contentVersion: "deadbeefdeadbeef",
  baseline: false,
  createdAt: "2026-10-14T00:42:00.000Z",
};

describe("Jev 问题构造与答案解析（mock 验证）", () => {
  it("每个启用需求一个 Choice 问题，需求语义在 instructions 中", () => {
    const { questions, needByQuestionId } = buildQuestions([NEED_A, NEED_B]);
    const idA = questionIdForNeed(NEED_A.id);
    expect(Object.keys(questions)).toHaveLength(2);
    expect(questions[idA].type).toBe("choice");
    expect(questions[idA].instructions).toContain("抽纸");
    expect(questions[idA].instructions).toContain("不要湿巾");
    expect(Object.keys(questions[idA].criteria)).toEqual([
      "matched",
      "not_matched",
      "uncertain",
    ]);
    expect(needByQuestionId.get(idA)?.id).toBe(NEED_A.id);
  });

  it("state 只包含有值字段且不含空字段", () => {
    const state = JSON.parse(buildState(BULLETIN)) as Record<string, unknown>;
    expect(state["线报标题"]).toBe(BULLETIN.title);
    expect(state["正文"]).toBe(BULLETIN.content);
    expect(state["品类"]).toBe(BULLETIN.category);
    expect(state["价格"]).toBe(9.9);
    expect(state["品牌"]).toBeUndefined();
  });

  it("三态正常映射并保留概率与置信度", () => {
    const parsed = parseAnswer({
      type: "choice",
      choice: "matched",
      probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
      confidence: 0.88,
    });
    expect(parsed.result).toBe("matched");
    expect(parsed.confidence).toBe(0.88);
    expect(parsed.probabilities?.matched).toBe(0.9);
  });

  it("未知 Choice 结果判为 failed，不伪造命中", () => {
    const parsed = parseAnswer({ type: "choice", choice: "maybe" });
    expect(parsed.result).toBe("failed");
    expect(parsed.error).toContain("未知");
  });

  it("类型不符（非 choice）判为 failed", () => {
    expect(parseAnswer({ type: "score", choice: "matched" }).result).toBe("failed");
    expect(parseAnswer({ type: "noul" }).result).toBe("failed");
  });

  it("缺失答案判为 failed", () => {
    expect(parseAnswer(undefined).result).toBe("failed");
    expect(parseAnswer(null).result).toBe("failed");
  });

  it("probabilities 类型不合法判为 failed", () => {
    const parsed = parseAnswer({
      type: "choice",
      choice: "matched",
      probabilities: { matched: "high" as unknown as number },
    });
    expect(parsed.result).toBe("failed");
  });

  it("多需求答案按 questionId 正确关联，缺失问题不影响其它需求", () => {
    const { questions } = buildQuestions([NEED_A, NEED_B]);
    const idA = questionIdForNeed(NEED_A.id);
    const idB = questionIdForNeed(NEED_B.id);
    const parsed = parseAnswers(
      { answers: { [idA]: { type: "choice", choice: "not_matched" } } },
      Object.keys(questions),
    );
    expect(parsed[idA].result).toBe("not_matched");
    expect(parsed[idB].result).toBe("failed");
  });

  it("响应缺 answers 时全部判为 failed", () => {
    const parsed = parseAnswers({}, ["need_x"]);
    expect(parsed["need_x"].result).toBe("failed");
  });
});
