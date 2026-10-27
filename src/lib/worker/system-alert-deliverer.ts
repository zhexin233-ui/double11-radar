import type Database from "better-sqlite3";
import { claimSystemAlertDelivery, dispatchSystemAlerts, finishSystemAlertDelivery, getSystemAlert } from "@/lib/db/repos/system-alerts";
import { getNotifyRuntimeConfig } from "@/lib/service/config";
import { sendForChannel } from "@/lib/notify/dispatch";
import { formatSystemAlert } from "@/lib/system-alerts/format";

export interface SystemAlertDelivererDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  key?: Buffer;
}

/** 与模型、线报队列完全独立；只保存固定失败提示及数值状态码。 */
export async function runSystemAlertDelivererOnce(db: Database.Database, deps: SystemAlertDelivererDeps = {}): Promise<number> {
  const now = () => deps.now?.() ?? new Date();
  // 在同步事务内读取首次分派的渠道配置，避免两个进程交错覆盖快照。
  db.transaction(() => {
    dispatchSystemAlerts(db, getNotifyRuntimeConfig(db, deps.key).enabledChannels, now());
  }).immediate();
  let processed = 0;
  for (; processed < 5; processed += 1) {
    const delivery = claimSystemAlertDelivery(db, now());
    if (!delivery) break;
    try {
      const runtime = getNotifyRuntimeConfig(db, deps.key);
      if (!runtime.enabledChannels.includes(delivery.channel)) {
        finishSystemAlertDelivery(db, delivery, "channel_disabled", now());
        continue;
      }
      const alert = getSystemAlert(db, delivery.alertId);
      if (!alert) {
        finishSystemAlertDelivery(db, delivery, "permanent", now());
        continue;
      }
      const result = await sendForChannel(delivery.channel, formatSystemAlert(alert), runtime, { fetchImpl: deps.fetchImpl });
      const permanentHttpError = result.httpStatus !== null && result.httpStatus >= 400
        && result.httpStatus < 500 && result.httpStatus !== 408 && result.httpStatus !== 429;
      const retryable = !permanentHttpError && (result.retryable || result.httpStatus === 429 || result.httpStatus === 408);
      finishSystemAlertDelivery(db, delivery, result.ok ? "succeeded" : retryable ? "retry" : "permanent", now(), result.httpStatus, result.bizCode);
    } catch {
      // 适配器/解密异常可能携带凭据；禁止保存或输出原始对象。
      finishSystemAlertDelivery(db, delivery, "retry", now());
    }
  }
  return processed;
}
