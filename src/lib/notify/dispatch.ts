import type Database from "better-sqlite3";
import { getNotificationByBulletin, createNotificationIfAbsent } from "@/lib/db/repos/notifications";
import { insertDeliveries } from "@/lib/db/repos/deliveries";
import { sendBark } from "@/lib/notify/bark";
import { sendFeishu } from "@/lib/notify/feishu";
import type { ChannelMessage, NotifyMessage, SendDependencies, SendResult } from "@/lib/notify/types";
import {
  getNotifyRuntimeConfig,
  type NotifyRuntimeConfig,
} from "@/lib/service/config";
import type {
  Bulletin,
  Evaluation,
  Notification,
  NotifyChannel,
} from "@/lib/domain/types";

/**
 * 通知构造与投递编排。
 *
 * - 一条线报的全部命中需求合并为**一条**通知；
 * - 事务内创建 notification 与每个已启用且已配置渠道的 delivery；
 * - 渠道全关时只保留判断记录，不创建 delivery；
 * - 分类说明是程序模板，明确标注为「程序生成」，不冒充模型生成理由。
 */

export function buildClassificationExplanation(needNames: string[]): string {
  return `该线报被 Jev 判为符合需求：${needNames.join("、")}`;
}

export interface NotificationPayload extends NotifyMessage {
  bulletinId: string;
  sourceNs: string;
  evaluations: Array<{
    needId: string;
    needName: string;
    result: string;
    confidence: number | null;
  }>;
}

export function buildNotificationPayload(
  bulletin: Bulletin,
  matched: Evaluation[],
): NotificationPayload {
  const needs = matched.map((evaluation) => evaluation.needName);
  return {
    bulletinId: bulletin.id,
    sourceNs: bulletin.sourceNs,
    bulletinTitle: bulletin.title,
    needs,
    explanation: buildClassificationExplanation(needs),
    url: bulletin.url,
    price: bulletin.price,
    brand: bulletin.brand,
    mall: bulletin.mall,
    channelName: bulletin.sourceNs,
    evaluations: matched.map((evaluation) => ({
      needId: evaluation.needId,
      needName: evaluation.needName,
      result: evaluation.result,
      confidence: evaluation.confidence,
    })),
  };
}

export interface CreateNotificationResult {
  notification: Notification;
  created: boolean;
  channels: NotifyChannel[];
}

/**
 * 幂等地创建通知与各渠道投递记录。
 * 已有通知时不重复创建投递（本地重放不会重复发送已成功任务）。
 */
export function createNotificationAndDeliveries(
  db: Database.Database,
  bulletin: Bulletin,
  matched: Evaluation[],
  key?: Buffer,
): CreateNotificationResult {
  const payload = buildNotificationPayload(bulletin, matched);
  const runtime = getNotifyRuntimeConfig(db, key);
  const create = db.transaction(() => {
    const { notification, created } = createNotificationIfAbsent(
      db,
      bulletin.id,
      payload,
    );
    if (!created) {
      return { notification, created, channels: [] as NotifyChannel[] };
    }
    const channels = runtime.enabledChannels;
    if (channels.length) {
      insertDeliveries(
        db,
        channels.map((channel) => ({
          notificationId: notification.id,
          bulletinId: bulletin.id,
          channel,
        })),
      );
    }
    return { notification, created, channels };
  });
  return create.immediate();
}

export function getNotificationPayload(
  db: Database.Database,
  bulletinId: string,
): NotificationPayload | null {
  const notification = getNotificationByBulletin(db, bulletinId);
  if (!notification) return null;
  try {
    return JSON.parse(notification.payload) as NotificationPayload;
  } catch {
    return null;
  }
}

/** 按渠道分派发送；未启用/未配置时返回不可重试的失败。 */
export async function sendForChannel(
  channel: NotifyChannel,
  message: ChannelMessage,
  runtime: NotifyRuntimeConfig,
  deps: SendDependencies = {},
): Promise<SendResult> {
  if (channel === "bark") {
    if (!runtime.bark) {
      return {
        ok: false,
        httpStatus: null,
        bizCode: null,
        response: null,
        error: "Bark 未启用或未配置设备 Key",
        retryable: false,
      };
    }
    return sendBark(message, runtime.bark, deps);
  }
  if (!runtime.feishu) {
    return {
      ok: false,
      httpStatus: null,
      bizCode: null,
      response: null,
      error: "飞书未启用或未配置 Webhook",
      retryable: false,
    };
  }
  return sendFeishu(
    message,
    {
      webhookUrl: runtime.feishu.webhookUrl,
      signingSecret: runtime.feishu.signingSecret,
      keywordPrefix: runtime.feishu.keywordPrefix,
    },
    deps,
  );
}

/** 单次渠道测试发送（不触发历史回放）。 */
export async function sendTestNotification(
  db: Database.Database,
  channel: NotifyChannel,
  key?: Buffer,
  deps: SendDependencies = {},
): Promise<SendResult> {
  const runtime = getNotifyRuntimeConfig(db, key);
  const message: NotifyMessage = {
    bulletinTitle: "测试线报：连接测试",
    needs: ["测试需求"],
    explanation: buildClassificationExplanation(["测试需求"]),
    url: "https://new.xianbao.fun/",
    price: null,
  };
  return sendForChannel(channel, message, runtime, deps);
}
