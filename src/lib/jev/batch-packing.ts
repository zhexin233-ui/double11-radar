import {
  MAX_BATCH_GATE_BYTES,
  MAX_BATCH_PART_MEMBERS,
} from "@/lib/domain/constants";
import type { NeedLike } from "@/lib/jev/prompt";
import {
  buildBatchGateRequest,
  type GateMember,
} from "@/lib/jev/batch-prompt";

/**
 * 批次装箱（纯函数，可在采集事务内同步执行）。
 *
 * 稳定顺序贪心分组：加入下一成员会超过成员数或 UTF-8 体积上限时封组。
 * - 单成员子批直接转为逐条（避免无意义门控请求）；
 * - 单成员连同完整问题就超限时直接逐条，绝不截断正文；
 * - 体积按与实际门控完全相同的 body 序列化计算（state + model + questions）。
 *
 * 这些都是保守保护值，不是官方 Token 等价换算。
 */

export interface PackBatchOptions {
  model: string;
  maxMembers?: number;
  maxBytes?: number;
}

export interface PackedBatchPlan {
  /** 需要门控的子批（每批至少 2 个成员）。 */
  parts: GateMember[][];
  /** 直接逐条的成员（单成员子批或无法装箱的单条）。 */
  singles: GateMember[];
}

/** 门控 body 的实际序列化（与调用端一致）。 */
export function buildBatchGateBody(
  members: GateMember[],
  needs: readonly NeedLike[],
  model: string,
): { state: string; model: string; questions: ReturnType<typeof buildBatchGateRequest>["questions"] } {
  const { state, questions } = buildBatchGateRequest(members, needs);
  return { state, model, questions };
}

/** 门控请求体的 UTF-8 字节数。 */
export function measureBatchGateBytes(
  members: GateMember[],
  needs: readonly NeedLike[],
  model: string,
): number {
  return Buffer.byteLength(JSON.stringify(buildBatchGateBody(members, needs, model)), "utf8");
}

export function packBatchParts(
  members: GateMember[],
  needs: readonly NeedLike[],
  options: PackBatchOptions,
): PackedBatchPlan {
  const maxMembers = options.maxMembers ?? MAX_BATCH_PART_MEMBERS;
  const maxBytes = options.maxBytes ?? MAX_BATCH_GATE_BYTES;
  const fits = (group: GateMember[]): boolean =>
    group.length <= maxMembers &&
    measureBatchGateBytes(group, needs, options.model) <= maxBytes;

  const parts: GateMember[][] = [];
  const singles: GateMember[] = [];
  let current: GateMember[] = [];

  const flush = (): void => {
    if (current.length >= 2) parts.push(current);
    else if (current.length === 1) singles.push(current[0]);
    current = [];
  };

  for (const member of members) {
    const candidate = [...current, member];
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    flush();
    // 单成员连同完整问题仍超限：直接逐条，不截断正文。
    if (fits([member])) {
      current = [member];
    } else {
      singles.push(member);
    }
  }
  flush();

  return { parts, singles };
}
