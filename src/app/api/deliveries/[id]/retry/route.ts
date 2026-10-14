import {
  getDelivery,
  resetDeliveryForRetry,
} from "@/lib/db/repos/deliveries";
import { HttpError, handleRoute, ok, requireSameOrigin } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 手动重试单个渠道投递。
 * 只重置该渠道；已成功的渠道不会被重新发送。
 */
export const POST = handleRoute<Ctx>(async (req, ctx) => {
  requireSameOrigin(req);
  const db = requireAuth(req);
  const { id } = await ctx.params;
  const delivery = getDelivery(db, id);
  if (!delivery) {
    throw new HttpError("NOT_FOUND", "投递记录不存在", 404);
  }
  if (delivery.status === "succeeded") {
    throw new HttpError("ALREADY_SUCCEEDED", "该渠道已成功投递，无需重试", 409);
  }
  const reset = resetDeliveryForRetry(db, id);
  if (!reset) {
    throw new HttpError("NOT_RETRYABLE", "当前状态不支持重试", 409);
  }
  return ok({ delivery: getDelivery(db, id) });
});
