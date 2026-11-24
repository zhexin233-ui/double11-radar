import { z } from "zod";
import { callOpenAiChatCompletion } from "@/lib/agent/llm-client";
import {
  getStage2Config,
  readStage2LlmApiKey,
  validateHttpUrlOrThrow,
} from "@/lib/service/stage2-config";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const TestSchema = z
  .object({
    baseUrl: z.string().trim().optional(),
    model: z.string().trim().optional(),
    timeoutMs: z.number().int().min(3000).max(120000).optional(),
    apiKey: z.string().trim().optional(),
  })
  .optional();

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);

  let rawBody: unknown = undefined;
  try {
    const text = await req.text();
    if (text.trim()) rawBody = JSON.parse(text);
  } catch {
    throw new HttpError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }

  const parsed = TestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw invalidBodyError(parsed.error);
  }

  const saved = getStage2Config(db).config;
  const savedKey = readStage2LlmApiKey(db);

  const baseUrl = parsed.data?.baseUrl
    ? validateHttpUrlOrThrow(parsed.data.baseUrl, "二级 LLM 服务地址")
    : saved.llm.baseUrl;
  const model = parsed.data?.model || saved.llm.model;
  const timeoutMs = parsed.data?.timeoutMs ?? saved.llm.timeoutMs;
  const apiKey = parsed.data?.apiKey || savedKey.apiKey;

  if (!apiKey) {
    throw new HttpError(
      "API_KEY_MISSING",
      savedKey.unreadable
        ? "已保存的二级 LLM 密钥无法解密，请重新输入后测试"
        : "请先输入或保存二级 LLM API 密钥",
      400,
    );
  }

  const start = Date.now();
  const res = await callOpenAiChatCompletion({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    temperature: 0,
    messages: [
      { role: "system", content: "You are a connectivity probe." },
      { role: "user", content: "Reply with OK." },
    ],
  });

  return ok({
    ok: true,
    model,
    baseUrl,
    latencyMs: Date.now() - start,
    replyPreview: (res.content ?? "").slice(0, 120),
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
});
