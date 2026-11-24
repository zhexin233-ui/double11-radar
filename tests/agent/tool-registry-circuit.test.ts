import { describe, expect, it } from "vitest";
import { createStage2Tool, getStage2Tool } from "@/lib/db/repos/stage2-tools";
import { buildRunnableTools } from "@/lib/agent/tools/registry";
import { createTestDb } from "../helpers/db";

describe("agent/tool-registry-circuit (AC6)", () => {
  it("业务 400/无结果不触发熔断；基础设施 5xx 连续达阈值后熔断并从工具列表摘除", async () => {
    const ctx = createTestDb();
    try {
      const ext = createStage2Tool(ctx.db, {
        name: "外部比价 API",
        kind: "http_api",
        config: {
          functionName: "ext_price",
          description: "查询外部价格",
          endpointUrl: "https://price.example.com/q",
          method: "GET",
          queryParamName: "q",
        },
        failureThreshold: 2,
        cooldownMinutes: 15,
      });

      const t0 = new Date("2026-11-24T12:00:00.000Z");

      // 1. 业务 404（非基础设施故障）不累计熔断
      const tools1 = buildRunnableTools(ctx.db, {
        now: t0,
        fetchImpl: async () => new Response("not found", { status: 404 }),
      });
      const extTool1 = tools1.find((t) => t.pluginId === ext.id)!;
      expect(extTool1).toBeDefined();
      const bizFail = await extTool1.execute({ query: "abc" });
      expect(bizFail.ok).toBe(false);
      expect(bizFail.infrastructureFailure).toBe(false);
      expect(getStage2Tool(ctx.db, ext.id)?.consecutiveFailures).toBe(0);
      expect(getStage2Tool(ctx.db, ext.id)?.healthStatus).toBe("healthy");

      // 2. 两次 503 基础设施故障后进入 open_circuit
      const tools2 = buildRunnableTools(ctx.db, {
        now: t0,
        fetchImpl: async () => new Response("bad gateway", { status: 503 }),
      });
      const extTool2 = tools2.find((t) => t.pluginId === ext.id)!;
      await extTool2.execute({ query: "abc" });
      expect(getStage2Tool(ctx.db, ext.id)?.consecutiveFailures).toBe(1);
      expect(getStage2Tool(ctx.db, ext.id)?.healthStatus).toBe("healthy");

      await extTool2.execute({ query: "abc" });
      expect(getStage2Tool(ctx.db, ext.id)?.consecutiveFailures).toBe(2);
      expect(getStage2Tool(ctx.db, ext.id)?.healthStatus).toBe("open_circuit");

      // 3. 冷却期内 buildRunnableTools 自动摘除该插件
      const t5m = new Date("2026-11-24T12:05:00.000Z");
      const toolsDuringCooldown = buildRunnableTools(ctx.db, { now: t5m });
      expect(
        toolsDuringCooldown.find((t) => t.pluginId === ext.id),
      ).toBeUndefined();

      // 4. 冷却到期后半开试探，成功即恢复 healthy
      const t16m = new Date("2026-11-24T12:16:00.000Z");
      const toolsAfterCooldown = buildRunnableTools(ctx.db, {
        now: t16m,
        fetchImpl: async () =>
          new Response(JSON.stringify({ price: 29.9 }), { status: 200 }),
      });
      const probeTool = toolsAfterCooldown.find((t) => t.pluginId === ext.id)!;
      expect(probeTool).toBeDefined();
      const okRes = await probeTool.execute({ query: "abc" });
      expect(okRes.ok).toBe(true);
      expect(getStage2Tool(ctx.db, ext.id)?.healthStatus).toBe("healthy");
      expect(getStage2Tool(ctx.db, ext.id)?.consecutiveFailures).toBe(0);
    } finally {
      ctx.close();
    }
  });
});
