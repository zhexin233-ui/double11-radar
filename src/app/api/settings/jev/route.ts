import { z } from "zod";
import {
  MAX_JE_CONCURRENCY,
  MAX_JOBS_PER_ROUND,
  MIN_JE_CONCURRENCY,
  MIN_JOBS_PER_ROUND,
  saveJevConfig,
  type SecretInput,
} from "@/lib/service/config";
import { getJevSettingsView } from "@/lib/service/jev-keys";
import { handleRoute, invalidBodyError, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const SecretInputSchema = z.union([
  z.string().max(500),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

const PutSchema = z.object({
  baseUrl: z.string({ error: "服务地址必须是文本" }).url("服务地址必须是合法 URL").max(500).optional(),
  model: z.string({ error: "模型标识必须是文本" }).trim().min(1, "模型标识不能为空").max(200).optional(),
  timeoutMs: z
    .number({ error: "超时必须是数字" })
    .int("超时必须是整数")
    .min(1000, "超时不能小于 1000 毫秒")
    .max(120000, "超时不能大于 120000 毫秒")
    .optional(),
  concurrency: z
    .number({ error: "并发数必须是数字" })
    .int("并发数必须是整数")
    .min(MIN_JE_CONCURRENCY, `并发数不能小于 ${MIN_JE_CONCURRENCY}`)
    .max(MAX_JE_CONCURRENCY, `并发数不能大于 ${MAX_JE_CONCURRENCY}`)
    .optional(),
  jobsPerRound: z
    .number({ error: "每轮任务数必须是数字" })
    .int("每轮任务数必须是整数")
    .min(MIN_JOBS_PER_ROUND, `每轮任务数不能小于 ${MIN_JOBS_PER_ROUND}`)
    .max(MAX_JOBS_PER_ROUND, `每轮任务数不能大于 ${MAX_JOBS_PER_ROUND}`)
    .optional(),
  apiKey: SecretInputSchema.optional(),
});

export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  // 基础配置 + 旧单 Key 兼容掩码 + 多 Key 列表（只返回掩码状态，绝无明文）。
  return ok(getJevSettingsView(db));
});

export const PUT = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const body = PutSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    // 透传字段级中文提示，避免只丢一个笼统的 INVALID_BODY。
    throw invalidBodyError(body.error);
  }
  const view = saveJevConfig(db, {
    baseUrl: body.data.baseUrl,
    model: body.data.model,
    timeoutMs: body.data.timeoutMs,
    concurrency: body.data.concurrency,
    jobsPerRound: body.data.jobsPerRound,
    apiKey: body.data.apiKey as SecretInput,
  });
  return ok(view);
});
