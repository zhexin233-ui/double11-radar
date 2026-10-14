/**
 * 外部调用网络层失败的统一中文描述。
 *
 * `fetch` 抛出的信息是英文的（`fetch failed`、`The operation was aborted.`），
 * 既不可读，也可能带上环境细节，而本项目的 API/页面消息一律要求中文。
 * 各适配器（Jev / 线报酷 / Bark / 飞书）共用这里的映射，原始异常只写入服务端日志。
 *
 * 注意：`target` 只能传**非敏感**地址。飞书 Webhook 属于凭据，绝不能出现在消息里。
 */

export function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

export interface NetworkFailureDescriptor {
  /** 出错的对象名，例如 "Jev 服务"、"线报酷接口"、"Bark 服务"、"飞书机器人"。 */
  service: string;
  timeoutMs: number;
  /** 非敏感的目标地址；凭据类地址不要传。 */
  target?: string | null;
  timeoutHint?: string;
  unreachableHint?: string;
}

export function describeNetworkFailure(
  error: unknown,
  descriptor: NetworkFailureDescriptor,
): string {
  const { service, timeoutMs, target } = descriptor;
  const name = errorName(error);
  const targetSuffix = target ? `（${target}）` : "";

  if (name === "AbortError" || name === "TimeoutError") {
    return `${service}调用超时（${timeoutMs} 毫秒）：${
      descriptor.timeoutHint ?? "请检查服务地址与 NAS 出网情况"
    }`;
  }
  return `${service}无法连接${targetSuffix}：${
    descriptor.unreachableHint ?? "请检查服务地址、NAS 出网与代理设置"
  }`;
}
