import type { SystemNotifyMessage } from "@/lib/notify/types";

export type AlertErrorCategory = "auth" | "rate_limit" | "upstream" | "network" | "invalid_response" | "unknown";

export function classifyAlertError(httpStatus: number | null, errorCode: string | null): AlertErrorCategory {
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 429 || httpStatus === 529) return "rate_limit";
  if (httpStatus !== null && httpStatus >= 500) return "upstream";
  if (errorCode === "network") return "network";
  if (errorCode === "invalid_response" || (httpStatus !== null && httpStatus >= 200 && httpStatus < 300)) return "invalid_response";
  return "unknown";
}

/** 显示名不是可信安全文本；不读取秘密，也不把地址或疑似凭据带入告警。 */
export function safeAlertName(value: string | null | undefined, fallback: string): string {
  const clean = (value ?? "")
    // 先去掉不可见字符，避免它们把地址或凭据前缀拆开而绕过遮盖。
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[地址已隐藏]")
    .replace(/(?:sk-|Bearer\s*)[\w.\-]+/gi, "[凭据已隐藏]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[疑似凭据已隐藏]")
    .trim().slice(0, 80);
  return clean || fallback;
}

const REASONS: Record<AlertErrorCategory, [string, string]> = {
  auth: ["认证失败", "请检查密钥凭据、权限和模型渠道配置。"],
  rate_limit: ["限流或过载", "请检查服务额度、调用频率和上游负载。"],
  upstream: ["上游服务异常", "请检查模型服务状态与接口可用性。"],
  network: ["网络或连接异常", "请检查接口地址、出网、DNS、代理节点及证书。"],
  invalid_response: ["响应格式异常", "请检查接口兼容性、模型配置与上游响应格式。"],
  unknown: ["未知请求异常", "请检查模型渠道、网络与服务状态。"],
};

export interface AlertContent {
  eventType?: "key_auto_disabled" | "key_auto_reenabled";
  channelName: string;
  keyLabel: string;
  consecutiveFailures: number;
  occurredAt: string;
  errorCategory: AlertErrorCategory | null;
  httpStatus: number | null;
}

export function alertReason(category: AlertErrorCategory | null): string {
  return category === null ? "等待期已结束，已自动重新启用；未验证实际可用" : REASONS[category][0];
}

export function formatSystemAlert(alert: AlertContent): SystemNotifyMessage {
  if (alert.eventType === "key_auto_reenabled") {
    return {
      kind: "system_alert",
      title: "模型密钥已自动重新启用",
      lines: [
        `模型渠道：${safeAlertName(alert.channelName, "未知渠道")}`,
        `密钥：${safeAlertName(alert.keyLabel, "未命名密钥")}`,
        `重新启用时间：${alert.occurredAt}`,
        `此前连续实际请求失败：${alert.consecutiveFailures} 次`,
        "等待期已结束，密钥已自动重新启用，可重新参与调度；未验证实际可用。",
        "未发起探测请求；现有限流冷却继续生效。",
      ],
    };
  }
  const [reason, advice] = REASONS[alert.errorCategory ?? "unknown"];
  return {
    kind: "system_alert",
    title: "模型密钥已自动停用",
    lines: [
      `模型渠道：${safeAlertName(alert.channelName, "未知渠道")}`,
      `密钥：${safeAlertName(alert.keyLabel, "未命名密钥")}`,
      `连续实际请求失败：${alert.consecutiveFailures} 次`,
      `发生时间：${alert.occurredAt}`,
      `错误类别：${reason}${alert.httpStatus === null ? "" : `（HTTP ${alert.httpStatus}）`}`,
      advice,
      "如已设置自动重新启用，将在等待期结束后重新参与调度；也可排查后手动恢复或替换密钥。",
    ],
  };
}
