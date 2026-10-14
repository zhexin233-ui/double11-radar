import { z } from "zod";

/**
 * TypeSafe Jev System One 响应的宽松校验。
 *
 * 官方协议只返回结构化决策，不生成自由文本。这里对字段保持宽松容错
 * （真实字段名在拿到真实凭据前未实测），但**三态枚举与答案完整性在
 * prompt.ts 中严格校验**：未知 choice、缺答案、类型不符都判为 failed。
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
  answers: z.record(z.string(), z.unknown()).optional(),
  usage: z.unknown().optional(),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;
