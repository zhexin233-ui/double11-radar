import type {
  AnalysisVerdict,
  NotifyChannel,
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

export function notificationTitle(message: ChannelMessage): string {
  if ("kind" in message) return message.title;
  if (message.analysis) {
    const badge = VERDICT_BADGE[message.analysis.verdict];
    return `[${badge}] ${message.analysis.productName}`;
  }
  if (message.needs.length === 1) {
    return `命中需求：${message.needs[0]}`;
  }
  return `命中 ${message.needs.length} 项需求`;
}

/** 纯文本正文，各渠道按自己格式复用。 */
export function notificationBodyLines(message: ChannelMessage): string[] {
  if ("kind" in message) return message.lines;

  if (message.analysis) {
    const a = message.analysis;
    const lines: string[] = [
      `结论（${VERDICT_BADGE[a.verdict]}）：${a.summary}`,
      `需求：${message.needs.join("、")}`,
    ];
    const priceParts: string[] = [];
    if (a.actualTotalPrice !== null) {
      priceParts.push(`到手 ${a.actualTotalPrice} 元`);
    }
    if (a.unitPrice !== null && a.unitLabel) {
      priceParts.push(`折算 ${a.unitPrice} ${a.unitLabel}`);
    }
    if (priceParts.length > 0) {
      lines.push(`价格：${priceParts.join(" | ")}`);
    }
    if (a.priceFormula) {
      lines.push(`算式：${a.priceFormula}`);
    }
    lines.push(
      `比价：${a.priceComparison.conclusion}${
        a.priceComparison.referencePrice !== null
          ? `（参考价 ${a.priceComparison.referencePrice} 元${
              a.priceComparison.source ? `，来源：${a.priceComparison.source}` : ""
            }）`
          : ""
      }`,
    );
    if (a.orderSteps.length > 0) {
      lines.push(`下单步骤：${a.orderSteps.join(" → ")}`);
    }
    if (a.risks.length > 0) {
      lines.push(`风险提示：${a.risks.join("；")}`);
    }
    if (message.mall || message.channelName) {
      const meta = [
        message.mall ? `商城：${message.mall}` : null,
        message.channelName ? `频道：${message.channelName}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      if (meta) lines.push(meta);
    }
    lines.push(`原线报：${message.bulletinTitle}`);
    return lines;
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
