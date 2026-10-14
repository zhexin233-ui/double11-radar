import type Database from "better-sqlite3";
import {
  claimDelivery,
  markDeliveryResult,
  reclaimExpiredDeliveryLeases,
} from "@/lib/db/repos/deliveries";
import { getNotificationPayload, sendForChannel } from "@/lib/notify/dispatch";
import type { NotifyMessage } from "@/lib/notify/types";
import { getNotifyRuntimeConfig } from "@/lib/service/config";
import { patchRuntimeState } from "@/lib/worker/runtime-state";
import type { AppEnv } from "@/lib/env";
import type { SendResult } from "@/lib/notify/types";

/**
 * 投递循环。
 *
 * 各渠道独立投递与重试：一个渠道成功、另一个失败时只重试失败渠道；
 * 已 `succeeded` 的记录不会被再次领取（本地重放不重复发送）；
 * 配置错误（不可重试）留在网页待人工处理；瞬时失败有限重试并退避。
 */

const LEASE_MS = 60_000;

export interface DelivererDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface DelivererRoundResult {
  processed: number;
  succeeded: number;
  failed: number;
  disabled: number;
}

export async function runDelivererOnce(
  db: Database.Database,
  _env: AppEnv,
  deps: DelivererDeps = {},
): Promise<DelivererRoundResult> {
  const now = deps.now?.() ?? new Date();
  reclaimExpiredDeliveryLeases(db, now);

  const stats: DelivererRoundResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    disabled: 0,
  };

  for (let i = 0; i < 5; i += 1) {
    const delivery = claimDelivery(db, "deliverer", LEASE_MS, now);
    if (!delivery) break;
    stats.processed += 1;

    const payload = getNotificationPayload(db, delivery.bulletinId);
    if (!payload) {
      markDeliveryResult(db, {
        id: delivery.id,
        status: "disabled",
        error: "通知内容缺失，无法投递",
      });
      stats.failed += 1;
      continue;
    }
    const message: NotifyMessage = {
      bulletinTitle: payload.bulletinTitle,
      needs: payload.needs,
      explanation: payload.explanation,
      url: payload.url,
      price: payload.price,
      brand: payload.brand,
      mall: payload.mall,
      channelName: payload.channelName,
    };

    const runtime = getNotifyRuntimeConfig(db);
    const configured =
      delivery.channel === "bark" ? runtime.bark : runtime.feishu;
    if (!configured) {
      markDeliveryResult(db, {
        id: delivery.id,
        status: "disabled",
        error: "该渠道已停用或未完成配置",
      });
      stats.disabled += 1;
      continue;
    }

    let result: SendResult;
    try {
      result = await sendForChannel(
        delivery.channel,
        message,
        runtime,
        deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        httpStatus: null,
        bizCode: null,
        response: null,
        error: detail,
        retryable: true,
      };
    }

    if (result.ok) {
      markDeliveryResult(db, {
        id: delivery.id,
        status: "succeeded",
        httpStatus: result.httpStatus,
        bizCode: result.bizCode,
        response: result.response,
      });
      stats.succeeded += 1;
      continue;
    }

    markDeliveryResult(db, {
      id: delivery.id,
      status: result.retryable ? "failed" : "disabled",
      httpStatus: result.httpStatus,
      bizCode: result.bizCode,
      response: result.response,
      error: result.error,
      retryAt: result.retryable
        ? new Date(
            now.getTime() + Math.min(2 ** (delivery.attempts + 1), 300) * 1000,
          ).toISOString()
        : null,
    });
    stats.failed += 1;
    patchRuntimeState(db, {
      lastError: `投递失败（${delivery.channel}）：${result.error ?? "未知错误"}${
        result.retryable ? "" : "（配置错误，已停止自动重试）"
      }`,
      lastErrorAt: now.toISOString(),
      lastErrorStage: "deliver",
    });
  }

  patchRuntimeState(db, { lastDeliverAt: now.toISOString() });
  return stats;
}
