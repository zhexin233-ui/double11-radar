import { z } from "zod";
import {
  buildConnectivityRequest,
  evaluateConnectivityResponse,
} from "@/lib/jev/client";
import { getJevConfig } from "@/lib/service/config";
import { callJevWithLedger } from "@/lib/service/jev-requests";
import { HttpError, handleRoute, invalidBodyError, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 单次 Jev 连接测试。
 *
 * - 复用统一请求服务：容量、Key 选择、失败计数与用量账本与生产判断一致，
 *   因此连接测试同样会进入费用统计（重试也是新的实际调用）；
 * - 可选 `keyId` 指定某个 Key 单测；已禁用或不可解密的 Key 必须先显式恢复/替换，
 *   不做隐式启用；
 * - 异常在服务完成账本与失败计数之后才转换为中文结果，不吞掉错误分类。
 */
const BodySchema = z.object({
  keyId: z
    .string({ error: "keyId 必须是文本" })
    .trim()
    .min(1, "keyId 不能为空")
    .max(200, "keyId 过长")
    .optional(),
});

export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const raw = await req.json().catch(() => ({}));
  const body = BodySchema.safeParse(raw ?? {});
  if (!body.success) throw invalidBodyError(body.error);

  const config = getJevConfig(db);
  const request = buildConnectivityRequest(config.model);

  const outcome = await callJevWithLedger(db, {
    purpose: "test",
    state: request.state,
    questions: request.questions,
    preferredKeyId: body.data.keyId ?? null,
  });

  if (outcome.status === "blocked") {
    // 未发出上游请求：不计失败、不计费；未配置用 400，其余（容量/退避/禁用）用 409。
    if (outcome.block.reason === "not_configured") {
      throw new HttpError("JE_NOT_CONFIGURED", outcome.block.message, 400);
    }
    throw new HttpError("JE_UNAVAILABLE", outcome.block.message, 409);
  }
  if (outcome.status === "failed") {
    // 账本与失败计数已在服务内完成；这里只把错误转成中文结果。
    return ok({ ok: false, message: outcome.error.message });
  }

  const result = evaluateConnectivityResponse(outcome.response);
  return ok({
    ...result,
    keyId: outcome.keyId,
    keyLabel: outcome.keyLabel,
  });
});
