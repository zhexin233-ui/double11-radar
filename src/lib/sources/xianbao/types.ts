import { z } from "zod";

/**
 * 线报酷外部响应的 zod 校验。
 *
 * 结构依据 `research/xianbao-live-samples.md` 的实测响应，外部一律先按 unknown 处理。
 * 普通分类流与值得买独立流字段不同，因此 **两套 item schema 独立定义**，不共用解析。
 */

/** 统一外层信封：`{ code, msg, data, meta? }`，`code === 0` 才算成功。 */
export const EnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown(),
  meta: z
    .object({
      api_version: z.string().optional(),
      generated_at: z.number().optional(),
      cache_ttl: z.number().optional(),
      note: z.string().optional(),
    })
    .optional(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

const CategorySchema = z.object({
  alias: z.string(),
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  has_price: z.boolean().optional(),
  rows_now: z.number().optional(),
  note: z.string().optional(),
});

/** `/api/v1/meta` 的 data 部分。 */
export const MetaDataSchema = z.object({
  abilities: z
    .object({
      feed: z
        .object({
          endpoint: z.string().optional(),
          categories: z.array(CategorySchema).optional(),
        })
        .optional(),
    })
    .optional(),
  rate_limit: z
    .object({
      limit: z.number().optional(),
      window_seconds: z.number().optional(),
      scope: z.string().optional(),
    })
    .optional(),
});

export type MetaCategory = z.infer<typeof CategorySchema>;

/** 普通分类流 item（实测 id 为数字，`category` 为对象）。 */
export const FeedItemSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string().nullish(),
  content: z.string().nullish(),
  url: z.string().nullish(),
  category: z
    .object({
      id: z.union([z.number(), z.string()]).nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
  price: z.number().nullish(),
  published_at: z.number().nullish(),
  published_text: z.string().nullish(),
  author: z.string().nullish(),
  comments: z.number().nullish(),
});

export type FeedItem = z.infer<typeof FeedItemSchema>;

/** 普通分类流的 data 部分。 */
export const FeedDataSchema = z.object({
  type: z.string().optional(),
  category: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      alias: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  count: z.number().optional(),
  items: z.array(z.unknown()),
});

/** 值得买独立流 item（实测 id 为字符串，另有 brand/mall/category_name）。 */
export const ZdmItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  type: z.string().optional(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  price: z.number().nullish(),
  brand: z.string().nullish(),
  mall: z.string().nullish(),
  category_name: z.string().nullish(),
  pic: z.string().nullish(),
  published_at: z.number().nullish(),
});

export type ZdmItem = z.infer<typeof ZdmItemSchema>;

/** 值得买独立流的 data 部分。 */
export const ZdmDataSchema = z.object({
  type: z.string().optional(),
  label: z.string().optional(),
  count: z.number().optional(),
  items: z.array(z.unknown()),
});

/**
 * 从 meta categories 归一化出的频道清单。
 * 注意：`zhidemai` 分类流与 `zdm` 独立流覆盖同一内容，必须在采集侧排除前者。
 */
export interface ChannelCatalogEntry {
  id: string;
  name: string;
  alias: string | null;
  origin: "feed" | "zdm";
}
