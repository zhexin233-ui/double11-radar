import { testJevConnection } from "@/lib/jev/client";
import { getJevRuntimeConfig } from "@/lib/service/config";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/** 单次 Jev 连接测试；只使用已保存的服务端配置，不回传明文。 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const runtime = getJevRuntimeConfig(db);
  if (!runtime) {
    throw new HttpError(
      "JE_NOT_CONFIGURED",
      "尚未配置 Jev API 密钥，请先保存配置",
      400,
    );
  }
  const result = await testJevConnection({
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    timeoutMs: runtime.timeoutMs,
  });
  return ok(result);
});
