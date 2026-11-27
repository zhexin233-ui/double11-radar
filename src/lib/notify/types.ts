import type {
  AnalysisVerdict,
  NotifyChannel,
  Stage2Ratings,
  StandardizedAnswer,
} from "@/lib/domain/types";

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
  /** 第二级标准化购买简报（存在时优先渲染决策卡片）。 */
  analysis?: StandardizedAnswer | null;
  /** 第二级失败降级提示（附加在一级模板末尾）。 */
  analysisFallbackNote?: string | null;
}

export interface SystemNotifyMessage {
  kind: "system_alert";
  title: string;
  lines: string[];
}

export type ChannelMessage = NotifyMessage | SystemNotifyMessage;

export type Stage2NotifyMessage = NotifyMessage & { analysis: StandardizedAnswer };

export function isStage2Notification(message: ChannelMessage): message is Stage2NotifyMessage {
  return !("kind" in message) && Boolean(message.analysis);
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

const VERDICT_BADGE: Record<AnalysisVerdict, string> = {
  recommended: "推荐",
  acceptable: "可考虑",
  rejected: "不推荐",
  insufficient_info: "待核对",
};

export const STAGE2_RATING_ROWS = [
  [
    { key: "priceValue", label: "价格力度", shortLabel: "价格" },
    { key: "needMatch", label: "需求契合", shortLabel: "契合" },
  ],
  [
    { key: "orderEase", label: "下单省心", shortLabel: "省心" },
    { key: "lowRisk", label: "低风险度", shortLabel: "低风险" },
  ],
] as const satisfies ReadonlyArray<ReadonlyArray<{
  key: keyof Stage2Ratings;
  label: string;
  shortLabel: string;
}>>;

export function formatStarRating(score: number | null | undefined, fallback = "暂无数据"): string {
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
    return fallback;
  }
  return "★".repeat(score) + "☆".repeat(5 - score);
}

function truncateCompactText(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(singleLine);
  return characters.length <= maxLength
    ? singleLine
    : `${characters.slice(0, maxLength - 1).join("")}…`;
}

function formatStage2PriceLine(answer: StandardizedAnswer): string {
  const priceParts: string[] = [];
  if (answer.actualTotalPrice !== null) {
    priceParts.push(`到手 ${answer.actualTotalPrice} 元`);
  }
  const unitLabel = truncateCompactText(answer.unitLabel ?? "", 24);
  if (answer.unitPrice !== null && unitLabel) {
    priceParts.push(`${answer.unitPrice} ${unitLabel}`);
  }
  return priceParts.join(" · ");
}

export function formatStage2CoreLine(message: Stage2NotifyMessage): string {
  const price = formatStage2PriceLine(message.analysis);
  const needs = truncateCompactText(message.needs.join("、"), 80);
  return [price, needs && `命中：${needs}`].filter(Boolean).join(" | ");
}

export function formatStage2ConclusionLines(answer: StandardizedAnswer): string[] {
  const summary = truncateCompactText(answer.summary, 80);
  const risks = truncateCompactText(answer.risks.map((risk) => risk.trim()).filter(Boolean).join("；"), 60);
  return [summary, risks && `注意：${risks}`].filter(Boolean);
}

export function notificationTitle(message: ChannelMessage): string {
  if ("kind" in message) return message.title;
  if (message.analysis) {
    const badge = VERDICT_BADGE[message.analysis.verdict];
    const stars = formatStarRating(message.analysis.ratings?.overall, "");
    return [`[${badge}]`, stars, truncateCompactText(message.analysis.productName, 80)].filter(Boolean).join(" ");
  }
  if (message.needs.length === 1) {
    return `命中需求：${message.needs[0]}`;
  }
  return `命中 ${message.needs.length} 项需求`;
}

/** 纯文本正文，各渠道按自己格式复用。 */
export function notificationBodyLines(message: ChannelMessage): string[] {
  if ("kind" in message) return message.lines;

  if (isStage2Notification(message)) {
    const { analysis } = message;
    const lines = [formatStage2CoreLine(message)];
    if (analysis.ratings) {
      const ratings = analysis.ratings;
      lines.push(
        STAGE2_RATING_ROWS.flat()
          .map(({ key, shortLabel }) => `${shortLabel} ${formatStarRating(ratings[key])}`)
          .join(" | "),
      );
    }
    return [...lines.filter(Boolean), ...formatStage2ConclusionLines(analysis)];
  }

  const lines: string[] = [`需求：${message.needs.join("、")}`];
  lines.push(`线报：${message.bulletinTitle}`);
  if (message.price !== null) {
    lines.push(`原文价格：${message.price} 元（来源标注，不代表券后实付）`);
  }
  if (message.brand) lines.push(`品牌：${message.brand}`);
  if (message.mall) lines.push(`商城：${message.mall}`);
  if (message.channelName) lines.push(`来源频道：${message.channelName}`);
  lines.push(`分类说明（程序生成）：${message.explanation}`);
  if (message.analysisFallbackNote) {
    lines.push(`注意：${message.analysisFallbackNote}`);
  }
  return lines;
}

export type { NotifyChannel };
