import { z } from "zod";
import type { StandardizedAnswer } from "@/lib/domain/types";

export const StandardizedAnswerSchema = z.object({
  verdict: z.enum([
    "recommended",
    "acceptable",
    "rejected",
    "insufficient_info",
  ]),
  summary: z.string().min(1, "summary 不能为空"),
  productName: z.string().min(1, "productName 不能为空"),
  actualTotalPrice: z.number().finite().nullable(),
  unitPrice: z.number().finite().nullable(),
  unitLabel: z.string().nullable(),
  priceFormula: z.string().nullable(),
  orderSteps: z.array(z.string()),
  priceComparison: z.object({
    status: z.enum(["cheaper", "fair", "expensive", "no_data"]),
    referencePrice: z.number().finite().nullable(),
    source: z.string().nullable(),
    conclusion: z.string().min(1, "priceComparison.conclusion 不能为空"),
  }),
  requirementChecks: z.array(
    z.object({
      needName: z.string().min(1),
      satisfied: z.boolean(),
      reason: z.string().min(1),
    }),
  ),
  risks: z.array(z.string()),
});

export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. 优先匹配 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) {
      return inner;
    }
  }

  // 2. 直接是 JSON 对象
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // 3. 从混杂文本中截取最外层 {...}
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

export function parseStandardizedAnswer(
  raw: string,
):
  | { ok: true; data: StandardizedAnswer }
  | { ok: false; error: string } {
  const extracted = extractJsonObject(raw);
  if (!extracted) {
    return { ok: false, error: "未在模型输出中找到合法的 JSON 对象" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    return {
      ok: false,
      error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const checked = StandardizedAnswerSchema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Schema 校验失败: ${issues}` };
  }

  return { ok: true, data: checked.data };
}
