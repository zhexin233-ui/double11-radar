import { retryAllDeadJobs, retryDeadJob } from "@/lib/db/repos/jobs";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

/**
 * 手动重试失败任务（dead -> pending）。
 * 传 `id` 时仅重试单条；不传 `id` 时重试全部 dead 任务。
 */
export const POST = handleRoute(async (req) => {
  requireSameOrigin(req);
  const db = requireAuth(req);

  let body: { id?: unknown } = {};
  const raw = await req.text();
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as { id?: unknown };
      } else {
        throw new HttpError("INVALID_JSON", "请求体必须是 JSON 对象", 400);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("INVALID_JSON", "请求体不是有效的 JSON", 400);
    }
  }

  if (body.id !== undefined) {
    if (typeof body.id !== "string" || body.id.trim().length === 0) {
      throw new HttpError("INVALID_INPUT", "任务 ID 无效", 400);
    }
    const retried = retryDeadJob(db, body.id.trim());
    if (!retried) {
      throw new HttpError("NOT_RETRYABLE", "任务不存在或当前不是失败状态", 409);
    }
    return ok({ retried: 1 });
  }

  const retried = retryAllDeadJobs(db);
  return ok({ retried });
});
