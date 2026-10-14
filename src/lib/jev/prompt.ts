import { AnswerSchema } from "@/lib/jev/types";
import type { Bulletin, ChoiceOutcome, Need } from "@/lib/domain/types";

/**
 * Jev 问题构造与答案解析。
 *
 * 关键约束：
 * - 需求语义写在 `instructions`，问题键（`need_<id>`）只是程序内部的稳定 ID，
 *   不能让模型把键名当成需求内容；
 * - 三态 criteria 固定为 matched / not_matched / uncertain；
 * - 只接受结构化 choice 结果，不解析任何自由文本；
 * - 未知 choice、缺答案、类型不符、probabilities 类型错误一律 `failed`，
 *   绝不当作命中。
 */

export interface JevQuestion {
  type: "choice";
  criteria: Record<ChoiceOutcome, string>;
  instructions: string;
}

export interface BuiltQuestions {
  questions: Record<string, JevQuestion>;
  needByQuestionId: Map<string, Need>;
}

export function questionIdForNeed(needId: string): string {
  return `need_${needId}`;
}

const CRITERIA: Record<ChoiceOutcome, string> = {
  matched:
    "线报的标题、正文或具体商品品类能明确支持该需求（含同义/近义描述，例如「软抽」属于「抽纸」），且不违反备注中的排除约束。",
  not_matched:
    "线报明确属于不相关品类，或明确违反备注中的排除约束（例如需求「抽纸，不要湿巾」遇到湿巾）。",
  uncertain:
    "现有信息不足，或只有品牌关联、没有可确认品类的商品描述，无法判断是否符合需求与备注约束。",
};

function buildInstructions(need: Need): string {
  const lines = [`用户购买需求：${need.name}`];
  if (need.note.trim()) {
    lines.push(`附加约束（必须同时满足）：${need.note.trim()}`);
  }
  lines.push(
    "请判断线报内容与该需求的关系。" +
      "只有能明确确认符合需求且不违反附加约束时才选择 matched；" +
      "明确不相关或违反约束时选择 not_matched；" +
      "信息不足或仅品牌相关时选择 uncertain。" +
      "不要因为出现关联品牌就判为 matched。",
  );
  return lines.join("\n");
}

/** 为每个启用需求构造一个 Choice 问题。 */
export function buildQuestions(needs: Need[]): BuiltQuestions {
  const questions: Record<string, JevQuestion> = {};
  const needByQuestionId = new Map<string, Need>();
  for (const need of needs) {
    const questionId = questionIdForNeed(need.id);
    questions[questionId] = {
      type: "choice",
      criteria: { ...CRITERIA },
      instructions: buildInstructions(need),
    };
    needByQuestionId.set(questionId, need);
  }
  return { questions, needByQuestionId };
}

/** 构造 state：只包含有值的字段，正文作为数据提供。 */
export function buildState(bulletin: Bulletin): string {
  const state: Record<string, string | number> = { 线报标题: bulletin.title };
  if (bulletin.content) state.正文 = bulletin.content;
  if (bulletin.category) state.品类 = bulletin.category;
  if (bulletin.brand) state.品牌 = bulletin.brand;
  if (bulletin.mall) state.商城 = bulletin.mall;
  if (bulletin.price !== null) state.价格 = bulletin.price;
  return JSON.stringify(state);
}

export interface ParsedAnswer {
  result: ChoiceOutcome | "failed";
  probabilities: Record<string, number> | null;
  confidence: number | null;
  raw: string | null;
  error: string | null;
}

const OUTCOMES: readonly ChoiceOutcome[] = [
  "matched",
  "not_matched",
  "uncertain",
];

function isOutcome(value: string): value is ChoiceOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

function failed(raw: unknown, error: string): ParsedAnswer {
  return {
    result: "failed",
    probabilities: null,
    confidence: null,
    raw: raw === undefined ? null : JSON.stringify(raw),
    error,
  };
}

/** 解析单个问题答案；调用方用 questionId → need 映射回需求。 */
export function parseAnswer(rawAnswer: unknown): ParsedAnswer {
  if (rawAnswer === undefined || rawAnswer === null) {
    return failed(rawAnswer, "缺少该问题的答案");
  }
  const parsed = AnswerSchema.safeParse(rawAnswer);
  if (!parsed.success) {
    return failed(rawAnswer, "答案结构不符合预期");
  }
  const answer = parsed.data;

  // 类型字段存在时必须是 choice；缺失时退化为按三态枚举判断（真实字段名待真实凭据核验）。
  if (answer.type !== undefined && answer.type !== "choice") {
    return failed(rawAnswer, `答案类型不是 choice（实际 ${answer.type}）`);
  }

  const chosen = answer.choice ?? answer.chosen ?? answer.value;
  if (typeof chosen !== "string" || !isOutcome(chosen)) {
    return failed(rawAnswer, `未知的 Choice 结果：${String(chosen)}`);
  }

  if (answer.probabilities !== undefined) {
    const entries = Object.entries(answer.probabilities);
    const valid = entries.every(
      ([key, value]) => typeof key === "string" && Number.isFinite(value),
    );
    if (!valid) {
      return failed(rawAnswer, "probabilities 结构不合法");
    }
  }

  return {
    result: chosen,
    probabilities: answer.probabilities ?? null,
    confidence:
      typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
        ? answer.confidence
        : null,
    raw: JSON.stringify(rawAnswer),
    error: null,
  };
}

/** 批量解析：逐 questionId 返回结果，缺失/非法一律 failed。 */
export function parseAnswers(
  response: unknown,
  questionIds: string[],
): Record<string, ParsedAnswer> {
  const answers = extractAnswers(response);
  const result: Record<string, ParsedAnswer> = {};
  for (const questionId of questionIds) {
    result[questionId] = parseAnswer(answers[questionId]);
  }
  return result;
}

function extractAnswers(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object") return {};
  const candidate = (response as { answers?: unknown }).answers;
  if (!candidate || typeof candidate !== "object") return {};
  return candidate as Record<string, unknown>;
}
