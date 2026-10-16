import type { Bulletin, ChoiceOutcome } from "@/lib/domain/types";
import {
  extractAnswers,
  parseAnswer,
  stateFieldsObject,
  type JevQuestion,
  type NeedLike,
} from "@/lib/jev/prompt";

/**
 * 批次初筛（batch_gate）的问题构造与严格解析。
 *
 * 一次门控只有一个问题 `batch_relevance`，state 携带稳定成员 ID 与完整字段；
 * 需求语义写在 instructions，不依赖 ID 传递。三态语义：
 * - matched：至少一条成员明确符合任一需求；
 * - uncertain：存在可能相关或信息不足，或无法明确排除；
 * - not_matched：能明确确认全部成员对全部需求均不匹配。
 *
 * 只有经过问题 ID 与结构校验的 not_matched 才允许整批结束；
 * 缺答案/多余答案/未知 choice 一律 `failed`，绝不当作未命中。
 */

export const BATCH_GATE_QUESTION_ID = "batch_relevance";

/** 门控 state 使用的成员：稳定 ID + 现有线报字段。 */
export interface GateMember {
  id: string;
  title: string;
  content?: string | null;
  category?: string | null;
  brand?: string | null;
  mall?: string | null;
  price?: number | null;
}

export function bulletinToMember(bulletin: Bulletin): GateMember {
  return {
    id: bulletin.id,
    title: bulletin.title,
    content: bulletin.content,
    category: bulletin.category,
    brand: bulletin.brand,
    mall: bulletin.mall,
    price: bulletin.price,
  };
}

export const BATCH_GATE_CRITERIA: Record<ChoiceOutcome, string> = {
  matched:
    "批次中至少有一条线报能明确符合任一用户购买需求（含同义/近义描述），且不违反该需求的附加约束。",
  not_matched:
    "批次中每一条线报都能明确确认对全部用户购买需求均不相关，且不存在信息不足或可能相关的成员。",
  uncertain:
    "存在可能相关但无法确认的成员，或某些成员的标题/正文信息不足，无法明确排除；也包括无法确认全部成员均不相关的情况。",
};

function buildGateInstructions(needs: readonly NeedLike[]): string {
  const lines: string[] = ["用户购买需求列表（全部需求，任一命中即算相关）："];
  if (needs.length === 0) {
    lines.push("（当前没有启用需求）");
  }
  for (const need of needs) {
    const note = need.note.trim();
    lines.push(`- ${need.name}${note ? `（附加约束：${note}）` : ""}`);
  }
  lines.push(
    "state 中 `批次成员` 是待判断的线报集合，每条成员都有稳定 `成员ID`。",
    "请判断这批成员与上述需求的关系：",
    "只有当 batch 中至少一条成员明确符合任一需求且不违反其附加约束时才选择 matched；",
    "只有能明确确认 batch 中每一条成员对全部需求都不相关时才选择 not_matched；",
    "只要存在可能相关、信息不足或无法明确排除的成员，就必须选择 uncertain。",
    "不要因为出现关联品牌就判为相关，也不要在信息不足时勉强选择 not_matched。",
  );
  return lines.join("\n");
}

export interface BuiltBatchGateRequest {
  state: string;
  questions: Record<string, JevQuestion>;
}

/** 构造批次门控请求（与装箱、实际调用共用同一序列化，保证体积一致）。 */
export function buildBatchGateRequest(
  members: GateMember[],
  needs: readonly NeedLike[],
): BuiltBatchGateRequest {
  const state = JSON.stringify({
    批次成员: members.map((member) => ({
      成员ID: member.id,
      ...stateFieldsObject({
        title: member.title,
        content: member.content,
        category: member.category,
        brand: member.brand,
        mall: member.mall,
        price: member.price,
      }),
    })),
  });
  return {
    state,
    questions: {
      [BATCH_GATE_QUESTION_ID]: {
        type: "choice",
        criteria: { ...BATCH_GATE_CRITERIA },
        instructions: buildGateInstructions(needs),
      },
    },
  };
}

export interface BatchGateParse {
  result: ChoiceOutcome | "failed";
  raw: string | null;
  error: string | null;
}

/** 严格解析门控响应：必须是唯一且合法的 `batch_relevance` 三态答案。 */
export function parseBatchGateResponse(response: unknown): BatchGateParse {
  const answers = extractAnswers(response);
  const keys = Object.keys(answers);
  if (!Object.prototype.hasOwnProperty.call(answers, BATCH_GATE_QUESTION_ID)) {
    return {
      result: "failed",
      raw: keys.length ? JSON.stringify(answers) : null,
      error: "门控响应缺少 batch_relevance 答案",
    };
  }
  const extra = keys.filter((key) => key !== BATCH_GATE_QUESTION_ID);
  if (extra.length > 0) {
    return {
      result: "failed",
      raw: JSON.stringify(answers),
      error: `门控响应包含多余的问题答案：${extra.join("、")}`,
    };
  }
  const parsed = parseAnswer(answers[BATCH_GATE_QUESTION_ID]);
  return { result: parsed.result, raw: parsed.raw, error: parsed.error };
}
