import {
  FeedDataSchema,
  FeedItemSchema,
  ZdmDataSchema,
  ZdmItemSchema,
} from "@/lib/sources/xianbao/types";
import { contentVersion } from "@/lib/domain/constants";
import { XIANBAO_SOURCE } from "@/lib/domain/constants";
import type { ChannelOrigin, NormalizedBulletin } from "@/lib/domain/types";

/**
 * 线报酷响应归一化。
 *
 * 普通分类流与值得买独立流使用各自独立的解析函数；字段缺失一律 null，
 * `price` 只有有限数字才取值（缺失 ≠ 0 元），`published_at` 由 Unix 秒转 UTC ISO。
 */

export interface NormalizeChannel {
  /** 频道稳定标识（feed 用别名，zdm 用 `zdm`）。 */
  id: string;
  alias: string | null;
  origin: ChannelOrigin;
}

/** Unix 秒 → UTC ISO8601；非法值返回 null。 */
export function fromUnixSeconds(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/** 只有有限数字才取价格；null/缺失/NaN 一律 null，绝不用 0 代替。 */
export function toPrice(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toNullableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** 归一化普通分类流。`channel.alias` 决定编号空间。 */
export function normalizeFeedItems(
  data: unknown,
  channel: NormalizeChannel,
): NormalizedBulletin[] {
  const parsedData = FeedDataSchema.safeParse(data);
  if (!parsedData.success) return [];
  const fallbackCategory = toNullableString(parsedData.data.category?.name);
  const sourceNs = `feed:${channel.alias ?? channel.id}`;

  const items: NormalizedBulletin[] = [];
  for (const rawItem of parsedData.data.items) {
    const parsedItem = FeedItemSchema.safeParse(rawItem);
    if (!parsedItem.success) continue;
    const item = parsedItem.data;
    const title = toNullableString(item.title);
    if (!title) continue;
    const content = toNullableString(item.content);
    const category = toNullableString(item.category?.name) ?? fallbackCategory;
    const price = toPrice(item.price);
    const brand: string | null = null;
    const mall: string | null = null;
    items.push({
      source: XIANBAO_SOURCE,
      sourceNs,
      sourceId: String(item.id),
      url: toNullableString(item.url) ?? "",
      title,
      content,
      category,
      price,
      brand,
      mall,
      publishedAt: fromUnixSeconds(item.published_at),
      payload: JSON.stringify(rawItem),
      contentVersion: contentVersion({ title, content, category, price, brand, mall }),
    });
  }
  return items;
}

/** 归一化值得买独立流。站外 smzdm id 独立编号空间，`content` 恒为 null。 */
export function normalizeZdmItems(data: unknown): NormalizedBulletin[] {
  const parsedData = ZdmDataSchema.safeParse(data);
  if (!parsedData.success) return [];

  const items: NormalizedBulletin[] = [];
  for (const rawItem of parsedData.data.items) {
    const parsedItem = ZdmItemSchema.safeParse(rawItem);
    if (!parsedItem.success) continue;
    const item = parsedItem.data;
    const title = toNullableString(item.title);
    if (!title) continue;
    const category = toNullableString(item.category_name);
    const price = toPrice(item.price);
    const brand = toNullableString(item.brand);
    const mall = toNullableString(item.mall);
    const content: string | null = null;
    items.push({
      source: XIANBAO_SOURCE,
      sourceNs: "zdm",
      sourceId: String(item.id),
      url: toNullableString(item.url) ?? "",
      title,
      content,
      category,
      price,
      brand,
      mall,
      publishedAt: fromUnixSeconds(item.published_at),
      payload: JSON.stringify(rawItem),
      contentVersion: contentVersion({ title, content, category, price, brand, mall }),
    });
  }
  return items;
}

/** 按频道 origin 分派到对应适配器。 */
export function normalizeItems(
  data: unknown,
  channel: NormalizeChannel,
): NormalizedBulletin[] {
  return channel.origin === "zdm"
    ? normalizeZdmItems(data)
    : normalizeFeedItems(data, channel);
}
