import { z } from "zod";
import {
  getStage2Config,
  readStage2LlmApiKey,
  resolveStage2DraftTestPricing,
  STAGE2_LLM_TIMEOUT_MAX_MS,
  STAGE2_LLM_TIMEOUT_MIN_MS,
  validateHttpUrlOrThrow,
} from "@/lib/service/stage2-config";
import { callStage2LlmWithLedger } from "@/lib/service/stage2-requests";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const OptionalRateSchema = z
  .number({ error: "单价必须为非负数字或留空" })
  .finite("单价必须为有限数字")
  .min(0, "单价不能为负数")
  .max(1_000_000, "单价超出允许范围")
  .nullable()
  .optional();

const TestSchema = z
  .object({
    baseUrl: z.string().trim().optional(),
    model: z.string().trim().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(STAGE2_LLM_TIMEOUT_MIN_MS)
      .max(STAGE2_LLM_TIMEOUT_MAX_MS)
      .optional(),
    apiKey: z.string().trim().optional(),
    inputUsdPerMillion: OptionalRateSchema,
    outputUsdPerMillion: OptionalRateSchema,
    openRouterModelId: z.string().trim().max(200).nullable().optional(),
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

  const savedSnapshot = getStage2Config(db);
  const saved = savedSnapshot.config;
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

  const draftPricing = resolveStage2DraftTestPricing(saved.llm, {
    baseUrl,
    model,
    inputUsdPerMillion: parsed.data?.inputUsdPerMillion,
    outputUsdPerMillion: parsed.data?.outputUsdPerMillion,
    openRouterModelId: parsed.data?.openRouterModelId,
  });

  const start = Date.now();
  const { response: res, requestId } = await callStage2LlmWithLedger(db, {
    purpose: "test",
    configVersion: savedSnapshot.version,
    manualInputUsdPerMillion: draftPricing.inputUsdPerMillion,
    manualOutputUsdPerMillion: draftPricing.outputUsdPerMillion,
    openRouterModelId: draftPricing.openRouterModelId,
    request: {
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a connectivity probe." },
        { role: "user", content: "Reply with OK." },
      ],
    },
  });

  return ok({
    ok: true,
    requestId,
    model,
    responseModel: res.responseModel,
    baseUrl,
    latencyMs: Date.now() - start,
    replyPreview: (res.content ?? "").slice(0, 120),
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
});
