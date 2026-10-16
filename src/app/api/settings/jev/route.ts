import { z } from "zod";
import {
  MAX_JE_CONCURRENCY,
  MAX_JOBS_PER_ROUND,
  MIN_JE_CONCURRENCY,
  MIN_JOBS_PER_ROUND,
  getJevConfig,
  normalizeJevRegexRules,
  saveJevConfig,
  type SecretInput,
} from "@/lib/service/config";
import { getJevSettingsView } from "@/lib/service/jev-keys";
import { createRegexRunner } from "@/lib/service/regex-runner";
import {
  HttpError,
  handleRoute,
  invalidBodyError,
  ok,
  requireSameOrigin,
} from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

const SecretInputSchema = z.union([
  z.string().max(500),
  z.object({ clear: z.literal(true) }),
  z.null(),
]);

/**
 * 每行一条正则 source：允许空白行（服务端归一化时忽略），
 * 但整体行数做一个宽松上限，具体条数/长度/体积由 `normalizeJevRegexRules` 校验。
 */
const RegexRulesSchema = z.union([
  z.array(z.string({ error: "正则规则必须是文本行" })).max(200, "正则规则行数过多"),
  z.string({ error: "正则规则必须是文本或文本数组" }).max(200_000),
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
  evaluationMode: z
    .enum(["individual", "batch_gate", "regex_gate"], {
      error: "处理模式不合法",
    })
    .optional(),
  regexRules: RegexRulesSchema.optional(),
  /** 新客户端提交的基线版本；不匹配时 409，避免把旧校验应用到新规则。 */
  version: z.number({ error: "配置版本必须是数字" }).int("配置版本必须是整数").nonnegative().optional(),
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
  const data = body.data;

  // 计算将生效的模式与规则（省略字段时保留旧值）。
  const current = getJevConfig(db);
  const mode = data.evaluationMode ?? current.evaluationMode;
  const rules =
    data.regexRules === undefined
      ? current.regexRules
      : normalizeJevRegexRules(data.regexRules);

  if (mode === "regex_gate" && rules.length === 0) {
    throw new HttpError(
      "INVALID_BODY",
      "正则预筛模式至少需要一条合法的正则规则",
      400,
    );
  }

  // 提交了规则或启用模式时才做线程内语法预检（事务外，事务内不 await）。
  const touchesStrategy =
    data.regexRules !== undefined || data.evaluationMode !== undefined;
  if (touchesStrategy && rules.length > 0) {
    const runner = createRegexRunner();
    try {
      const checked = await runner.validate(rules);
      if (!checked.ok) {
        throw new HttpError(
          "INVALID_BODY",
          `正则规则语法错误：${checked.error}`,
          400,
        );
      }
    } finally {
      runner.dispose();
    }
  }

  const view = saveJevConfig(db, {
    baseUrl: data.baseUrl,
    model: data.model,
    timeoutMs: data.timeoutMs,
    concurrency: data.concurrency,
    jobsPerRound: data.jobsPerRound,
    evaluationMode: data.evaluationMode,
    regexRules: data.regexRules !== undefined ? rules : undefined,
    expectedVersion: data.version,
    apiKey: data.apiKey as SecretInput,
  });
  return ok(view);
});
