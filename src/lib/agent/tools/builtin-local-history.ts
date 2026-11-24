import type Database from "better-sqlite3";
import type { LocalHistoryToolConfig, Stage2ToolRecord } from "@/lib/domain/types";
import type { RegisteredTool, ToolExecutionOutcome } from "@/lib/agent/tools/types";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function computeMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
}

export function createLocalHistoryTool(
  db: Database.Database,
  plugin: Stage2ToolRecord,
  currentBulletinId?: string,
  now: Date = new Date(),
): RegisteredTool {
  const cfg = (plugin.config ?? {}) as LocalHistoryToolConfig;
  const defaultDays =
    typeof cfg.historyDays === "number" && cfg.historyDays >= 1
      ? Math.min(365, Math.round(cfg.historyDays))
      : 90;
  const maxResults =
    typeof cfg.maxResults === "number" && cfg.maxResults >= 1
      ? Math.min(50, Math.round(cfg.maxResults))
      : 20;

  const functionName = "search_local_history";

  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    functionName,
    definition: {
      type: "function",
      function: {
        name: functionName,
        description:
          "检索本库近 N 天内同关键词或同品牌的历史线报价格分布（样本数、最低价、中位价、均价与近期样本），用于判断当前价格是否处于历史好价区间。",
        parameters: {
          type: "object",
          properties: {
            keywords: {
              type: "array",
              items: { type: "string" },
              description: "用于匹配标题的关键词列表（1-4 个，如 ['维达', '抽纸']）",
            },
            brand: {
              type: "string",
              description: "可选品牌名过滤",
            },
            days: {
              type: "number",
              description: `回溯天数（默认 ${defaultDays} 天，范围 1-365）`,
            },
          },
          required: ["keywords"],
        },
      },
    },
    execute: async (args): Promise<ToolExecutionOutcome> => {
      const rawKeywords = Array.isArray(args.keywords)
        ? args.keywords
            .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
            .map((k) => k.trim())
            .slice(0, 4)
        : [];

      if (rawKeywords.length === 0) {
        const msg = "keywords 不能为空，请提供至少 1 个商品关键词";
        return {
          ok: false,
          infrastructureFailure: false,
          content: JSON.stringify({ error: msg }),
          error: msg,
        };
      }

      const days =
        typeof args.days === "number" && Number.isFinite(args.days) && args.days >= 1
          ? Math.min(365, Math.round(args.days))
          : defaultDays;
      const cutoffIso = new Date(
        now.getTime() - days * 24 * 60 * 60 * 1000,
      ).toISOString();

      const whereClauses: string[] = [
        "created_at >= ?",
        "price IS NOT NULL",
        "price > 0",
      ];
      const params: unknown[] = [cutoffIso];

      if (currentBulletinId) {
        whereClauses.push("id != ?");
        params.push(currentBulletinId);
      }

      for (const kw of rawKeywords) {
        whereClauses.push("LOWER(title) LIKE LOWER(?) ESCAPE '\\'");
        params.push(`%${escapeLike(kw)}%`);
      }

      const brand = typeof args.brand === "string" ? args.brand.trim() : "";
      if (brand) {
        whereClauses.push(
          "(LOWER(COALESCE(brand, '')) LIKE LOWER(?) ESCAPE '\\' OR LOWER(title) LIKE LOWER(?) ESCAPE '\\')",
        );
        const brandPattern = `%${escapeLike(brand)}%`;
        params.push(brandPattern, brandPattern);
      }

      const sql = `
        SELECT id, title, price, brand, mall, published_at, created_at
        FROM bulletins
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params.push(maxResults);

      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        title: string;
        price: number;
        brand: string | null;
        mall: string | null;
        published_at: string | null;
        created_at: string;
      }>;

      if (rows.length === 0) {
        return {
          ok: true,
          infrastructureFailure: false,
          content: JSON.stringify({
            sampleCount: 0,
            days,
            keywords: rawKeywords,
            minPrice: null,
            medianPrice: null,
            avgPrice: null,
            recentSamples: [],
            message: `近 ${days} 天本地历史线报库中未找到匹配样本`,
          }),
        };
      }

      const prices = rows.map((r) => r.price).sort((a, b) => a - b);
      const minPrice = prices[0];
      const medianPrice = computeMedian(prices);
      const avgPrice = Number(
        (prices.reduce((acc, p) => acc + p, 0) / prices.length).toFixed(2),
      );

      return {
        ok: true,
        infrastructureFailure: false,
        content: JSON.stringify({
          sampleCount: rows.length,
          days,
          keywords: rawKeywords,
          minPrice,
          medianPrice,
          avgPrice,
          recentSamples: rows.slice(0, 8).map((r) => ({
            title: r.title,
            price: r.price,
            mall: r.mall,
            createdAt: r.published_at ?? r.created_at,
          })),
        }),
      };
    },
  };
}
