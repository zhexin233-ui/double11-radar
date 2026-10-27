import { describeNetworkFailure } from "@/lib/http/network-error";
import {
  BARK_GROUP,
  NOTIFY_TIMEOUT_MS,
  notificationBodyLines,
  notificationTitle,
  type ChannelMessage,
  type SendDependencies,
  type SendResult,
} from "@/lib/notify/types";

/**
 * Bark 推送（首版固定一个设备）。
 *
 * `POST {serverUrl}/push`，成功 = HTTP 2xx 且响应 JSON `code === 200`；
 * 响应可能不是 JSON，需要容错并按可重试失败处理。
 */

export interface BarkConfig {
  serverUrl: string;
  deviceKey: string;
}

function failure(
  error: string,
  options: Partial<SendResult> = {},
): SendResult {
  return {
    ok: false,
    httpStatus: options.httpStatus ?? null,
    bizCode: options.bizCode ?? null,
    response: options.response ?? null,
    error,
    retryable: options.retryable ?? true,
  };
}

export async function sendBark(
  message: ChannelMessage,
  config: BarkConfig,
  deps: SendDependencies = {},
): Promise<SendResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = config.serverUrl.replace(/\/+$/, "");
  const url = `${base}/push`;
  const body = {
    device_key: config.deviceKey,
    title: notificationTitle(message),
    body: notificationBodyLines(message).join("\n"),
    url: "kind" in message ? undefined : message.url || undefined,
    group: "kind" in message ? "系统故障告警" : BARK_GROUP,
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[bark] 投递网络异常，请检查通知渠道配置与出网");
    return failure(
      describeNetworkFailure(error, {
        service: "Bark 服务",
        target: config.serverUrl,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        timeoutHint: "请检查服务地址与 NAS 出网情况",
        unreachableHint: "请检查服务地址、NAS 出网与设备 Key 是否正确",
      }),
    );
  }

  const text = await response.text();
  let code: number | null = null;
  try {
    const json = JSON.parse(text) as { code?: unknown };
    if (typeof json.code === "number") code = json.code;
  } catch {
    return failure("Bark 响应不是合法 JSON", {
      httpStatus: response.status,
      response: text.slice(0, 500),
      retryable: true,
    });
  }

  if (!response.ok) {
    return failure(`Bark 返回 HTTP ${response.status}`, {
      httpStatus: response.status,
      bizCode: code === null ? null : String(code),
      response: text.slice(0, 500),
      retryable: response.status >= 500,
    });
  }

  if (code !== 200) {
    return failure(`Bark 业务返回码非 200（code=${String(code)}）`, {
      httpStatus: response.status,
      bizCode: code === null ? null : String(code),
      response: text.slice(0, 500),
      retryable: false,
    });
  }

  return {
    ok: true,
    httpStatus: response.status,
    bizCode: String(code),
    response: text.slice(0, 500),
    error: null,
    retryable: false,
  };
}
