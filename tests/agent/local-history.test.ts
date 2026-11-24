import { describe, expect, it } from "vitest";
import { createLocalHistoryTool } from "@/lib/agent/tools/builtin-local-history";
import { getStage2Tool } from "@/lib/db/repos/stage2-tools";
import { createTestDb } from "../helpers/db";

function seedBulletin(
  ctx: ReturnType<typeof createTestDb>,
  id: string,
  title: string,
  price: number | null,
  createdAt: string,
) {
  ctx.db
    .prepare(
      `INSERT INTO bulletins
        (id, source, source_ns, source_id, url, title, content, category, price, brand, mall, published_at, payload, content_version, baseline, created_at)
       VALUES (?, 'xianbao', 'feed:test', ?, ?, ?, NULL, NULL, ?, '维达', '京东', ?, '{}', 'v1', 0, ?)`,
    )
    .run(id, id, `https://example.com/${id}`, title, price, createdAt, createdAt);
}

describe("agent/builtin-local-history (AC4)", () => {
  it("准确检索近 N 天同关键词历史价格、排除当前线报并计算统计值", async () => {
    const ctx = createTestDb();
    try {
      const now = new Date("2026-11-24T12:00:00.000Z");
      seedBulletin(ctx, "cur", "维达抽纸 24 包 29.9元", 29.9, "2026-11-24T11:00:00.000Z");
      seedBulletin(ctx, "h1", "维达抽纸 24 包 好价", 25.0, "2026-11-20T10:00:00.000Z");
      seedBulletin(ctx, "h2", "维达抽纸 24 包 促销", 35.0, "2026-11-10T10:00:00.000Z");
      seedBulletin(ctx, "h3", "维达抽纸 24 包 活动", 30.0, "2026-11-01T10:00:00.000Z");
      seedBulletin(ctx, "h-null", "维达抽纸 24 包 无价", null, "2026-11-05T10:00:00.000Z");
      seedBulletin(ctx, "old", "维达抽纸 24 包 半年前", 19.9, "2026-01-01T10:00:00.000Z");

      const plugin = getStage2Tool(ctx.db, "builtin-local-history")!;
      const tool = createLocalHistoryTool(ctx.db, plugin, "cur", now);

      const res = await tool.execute({ keywords: ["维达", "抽纸"] });
      expect(res.ok).toBe(true);
      const data = JSON.parse(res.content);
      expect(data.sampleCount).toBe(3);
      expect(data.minPrice).toBe(25);
      expect(data.medianPrice).toBe(30);
      expect(data.avgPrice).toBe(30);
      expect(data.recentSamples).toHaveLength(3);

      // 无样本时诚实返回 0 样本
      const emptyRes = await tool.execute({ keywords: ["不存在的商品XYZ"] });
      expect(emptyRes.ok).toBe(true);
      const emptyData = JSON.parse(emptyRes.content);
      expect(emptyData.sampleCount).toBe(0);
      expect(emptyData.minPrice).toBeNull();
    } finally {
      ctx.close();
    }
  });
});
