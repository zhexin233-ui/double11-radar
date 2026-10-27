import { describeNetworkFailure } from "@/lib/http/network-error";
import { genFeishuSign } from "@/lib/notify/feishu-sign";
import {
  NOTIFY_TIMEOUT_MS,
  notificationBodyLines,
  notificationTitle,
  type ChannelMessage,
  type SendDependencies,
  type SendResult,
} from "@/lib/notify/types";

/**
 * 飞书群自定义机器人 Webhook 推送（首版固定一个群）。
 *
 * - `msg_type: "post"`，`content` 是**对象**（不是字符串化的 JSON）；
 * - 链接使用 `{ tag: "a", text, href }` 节点，不用 Markdown 语法；
 * - 开启签名时按官方 Method 3 生成 `timestamp` / `sign` 放在 body 顶层；
 * - 成功 = HTTP 2xx **且** 业务 `code === 0`；非零码必须记录，不能仅凭 HTTP200 判成功；
 * - `19021/19022/19024`（签名/IP/关键词）属配置错误，不自动重试。
 */

export const FEISHU_CONFIG_ERROR_CODES = new Set(["19021", "19022", "19024"]);

export interface FeishuConfig {
  webhookUrl: string;
  signingSecret?: string | null;
  keywordPrefix?: string | null;
}

function failure(error: string, options: Partial<SendResult> = {}): SendResult {
  return {
    ok: false,
    httpStatus: options.httpStatus ?? null,
    bizCode: options.bizCode ?? null,
    response: options.response ?? null,
    error,
    retryable: options.retryable ?? true,
  };
}

interface FeishuPostContent {
  zh_cn: {
    title: string;
    content: Array<Array<Record<string, string>>>;
  };
}

/** 构造 post 富文本内容。 */
export function buildFeishuPost(
  message: ChannelMessage,
  keywordPrefix?: string | null,
): FeishuPostContent {
  const baseTitle = notificationTitle(message);
  const title = keywordPrefix ? `${keywordPrefix}${baseTitle}` : baseTitle;
  const paragraphs: Array<Array<Record<string, string>>> = [
    [{ tag: "text", text: notificationBodyLines(message).join("\n") }],
  ];
  if (!("kind" in message) && message.url) {
    paragraphs.push([
      { tag: "a", text: "查看原始线报", href: message.url },
    ]);
  }
  return { zh_cn: { title, content: paragraphs } };
}

export async function sendFeishu(
  message: ChannelMessage,
  config: FeishuConfig,
  deps: SendDependencies = {},
): Promise<SendResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timestamp = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    msg_type: "post",
    content: { post: buildFeishuPost(message, config.keywordPrefix) },
  };
  if (config.signingSecret) {
    body.timestamp = String(timestamp);
    body.sign = genFeishuSign(config.signingSecret, timestamp);
  }

  let response: Response;
  try {
    response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[feishu] 投递网络异常，请检查通知渠道配置与出网");
    // 注意：不把 Webhook 地址写进消息——它本身是凭据。
    return failure(
      describeNetworkFailure(error, {
        service: "飞书机器人",
        timeoutMs: NOTIFY_TIMEOUT_MS,
        timeoutHint: "请检查 NAS 出网情况与飞书服务状态",
        unreachableHint: "请检查 Webhook 地址、NAS 出网与飞书侧的白名单设置",
      }),
    );
  }

  const text = await response.text();
  let bizCode: string | null = null;
  let bizMessage: string | null = null;
  try {
    const json = JSON.parse(text) as { code?: unknown; msg?: unknown };
    if (typeof json.code === "number") bizCode = String(json.code);
    if (typeof json.msg === "string") bizMessage = json.msg;
  } catch {
    return failure("飞书响应不是合法 JSON", {
      httpStatus: response.status,
      response: text.slice(0, 500),
      retryable: true,
    });
  }

  if (!response.ok) {
    return failure(`飞书返回 HTTP ${response.status}`, {
      httpStatus: response.status,
      bizCode,
      response: text.slice(0, 500),
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  if (bizCode !== "0") {
    const retryable = bizCode === null || !FEISHU_CONFIG_ERROR_CODES.has(bizCode);
    const detail = bizMessage ? `：${bizMessage}` : "";
    return failure(
      `飞书业务返回码非 0（code=${String(bizCode)}${detail}）`,
      {
        httpStatus: response.status,
        bizCode,
        response: text.slice(0, 500),
        retryable,
      },
    );
  }

  return {
    ok: true,
    httpStatus: response.status,
    bizCode,
    response: text.slice(0, 500),
    error: null,
    retryable: false,
  };
}
