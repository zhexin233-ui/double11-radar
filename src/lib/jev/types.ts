import { z } from "zod";
import { parseTokenCount } from "@/lib/jev/pricing";

/**
 * TypeSafe Jev System One 响应的宽松校验。
 *
 * 官方协议只返回结构化决策，不生成自由文本。这里对顶层字段保持宽松容错，
 * 但**要求 `answers` 存在**：连 answers 都没有的响应属于结构异常，必须计为调用失败，
 * 不能被当作「没有匹配」。三态枚举与单题答案完整性在 prompt.ts 中严格校验：
 * 未知 choice、缺答案、类型不符都判为 failed。
 *
 * usage 的字段名遵循官方约定的 `input_tokens` / `output_tokens`；这里是宽松的
 * `unknown`，由适配器用 `parseTokenCount` 归一化为有限非负安全整数，缺失即为未知。
 */

export const AnswerSchema = z.object({
  type: z.string().optional(),
  choice: z.string().optional(),
  chosen: z.string().optional(),
  value: z.string().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().optional(),
});

export type RawAnswer = z.infer<typeof AnswerSchema>;

export const SystemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.unknown().optional(),
});

export type RawSystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

/** 归一化后的用量：缺失/非法一律为 null（未知），绝不用 0 冒充。 */
export interface JevUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 一次成功响应（含非敏感元数据，供调用账本使用）。 */
export interface SystemOneResponse {
  model: string | null;
  answers: Record<string, unknown>;
  usage: JevUsage;
  upstreamRequestId: string | null;
  httpStatus: number;
}

/**
 * 把上游 usage 归一化。只接受官方契约里的 `input_tokens` / `output_tokens`；
 * 其他字段或非对象正文一律忽略，避免把任意文本误当用量。
 */
export function normalizeUsage(raw: unknown): JevUsage {
  if (!raw || typeof raw !== "object") {
    return { inputTokens: null, outputTokens: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    inputTokens: parseTokenCount(record.input_tokens),
    outputTokens: parseTokenCount(record.output_tokens),
  };
}

/** 从响应体（可能是非 2xx 的错误体）中提取符合契约的 usage；不匹配则为空。 */
export function extractUsageFromJson(json: unknown): JevUsage {
  if (!json || typeof json !== "object") {
    return { inputTokens: null, outputTokens: null };
  }
  return normalizeUsage((json as { usage?: unknown }).usage);
}
