import { XIANBAO_SOURCE } from "@/lib/domain/constants";

/** 普通分类共用原文 ID；值得买和未知来源仍保留独立编号空间。 */
export function notificationIdentityNamespace(source: string, sourceNs: string): string {
  return source === XIANBAO_SOURCE && sourceNs.startsWith("feed:") ? "feed" : sourceNs;
}
