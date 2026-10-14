import type { NotifyChannel } from "@/lib/domain/types";

/**
 * 通知领域的共享类型。
 *
 * `NotifyMessage` 是一条命中线报合并后的通知内容（多需求合并为一条）；
 * `SendResult` 是各渠道统一的发送结果，`retryable` 区分「瞬时失败可重试」
 * 与「配置错误需人工处理」。
 */

export interface NotifyMessage {
  /** 原始线报标题。 */
  bulletinTitle: string;
  /** 命中的需求名称列表。 */
  needs: string[];
  /** 程序生成的分类说明（不是模型生成的理由）。 */
  explanation: string;
  /** 原始线报链接。 */
  url: string;
  /** 来源明确提供的价格；缺失为 null（不显示 0 元）。 */
  price: number | null;
  brand?: string | null;
  mall?: string | null;
  channelName?: string | null;
}

export interface SendResult {
  ok: boolean;
  httpStatus: number | null;
  bizCode: string | null;
  response: string | null;
  error: string | null;
  retryable: boolean;
}

export interface SendDependencies {
  fetchImpl?: typeof fetch;
}

export const BARK_GROUP = "线报需求匹配";

/** 推送渠道单次投递超时（毫秒）。 */
export const NOTIFY_TIMEOUT_MS = 15000;

export function notificationTitle(message: NotifyMessage): string {
  if (message.needs.length === 1) {
    return `命中需求：${message.needs[0]}`;
  }
  return `命中 ${message.needs.length} 项需求`;
}

/** 纯文本正文，各渠道按自己格式复用。 */
export function notificationBodyLines(message: NotifyMessage): string[] {
  const lines: string[] = [`需求：${message.needs.join("、")}`];
  lines.push(`线报：${message.bulletinTitle}`);
  if (message.price !== null) {
    lines.push(`原文价格：${message.price} 元（来源标注，不代表券后实付）`);
  }
  if (message.brand) lines.push(`品牌：${message.brand}`);
  if (message.mall) lines.push(`商城：${message.mall}`);
  if (message.channelName) lines.push(`来源频道：${message.channelName}`);
  lines.push(`分类说明（程序生成）：${message.explanation}`);
  return lines;
}

export type { NotifyChannel };
