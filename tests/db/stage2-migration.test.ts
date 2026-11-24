import { describe, expect, it } from "vitest";
import { migrate } from "@/lib/db/migrate";
import {
  listStage2Tools,
  listRunnableStage2Tools,
  recordStage2ToolFailure,
  recordStage2ToolSuccess,
  resetStage2ToolCircuit,
  createStage2Tool,
  deleteStage2Tool,
} from "@/lib/db/repos/stage2-tools";
import {
  upsertBulletinAnalysis,
  getBulletinAnalysis,
  markAnalysisFallbackNotified,
} from "@/lib/db/repos/analyses";
import { createTestDb } from "../helpers/db";

describe("V11 stage2_tools & bulletin_analyses", () => {
  it("V11 幂等迁移并预置 2 个内置工具插件", () => {
    const ctx = createTestDb();
    try {
      const tools = listStage2Tools(ctx.db);
      expect(tools.map((t) => t.id)).toEqual([
        "builtin-calculator",
        "builtin-local-history",
      ]);
      expect(tools[0]).toMatchObject({
        kind: "builtin",
        builtinKey: "calculator",
        enabled: true,
        healthStatus: "healthy",
        failureThreshold: 3,
        cooldownMinutes: 15,
      });
      expect(tools[1]).toMatchObject({
        kind: "builtin",
        builtinKey: "local_history",
        enabled: true,
        config: { historyDays: 90, maxResults: 20 },
      });

      // 重复迁移不重复插入或覆盖
      const second = migrate(ctx.db);
      expect(second.applied).toEqual([]);
      expect(listStage2Tools(ctx.db)).toHaveLength(2);
    } finally {
      ctx.close();
    }
  });

  it("stage2_tools 熔断计数、冷却过滤与半开试探恢复", () => {
    const ctx = createTestDb();
    try {
      const ext = createStage2Tool(ctx.db, {
        name: "测试比价 MCP",
        kind: "mcp",
        config: { endpointUrl: "https://example.com/mcp" },
        failureThreshold: 2,
        cooldownMinutes: 15,
      });

      const t0 = new Date("2026-11-24T10:00:00.000Z");
      expect(listRunnableStage2Tools(ctx.db, t0).map((t) => t.id)).toContain(ext.id);

      // 第 1 次基础设施失败：尚未熔断
      const f1 = recordStage2ToolFailure(ctx.db, ext.id, "timeout", t0);
      expect(f1?.healthStatus).toBe("healthy");
      expect(f1?.consecutiveFailures).toBe(1);
      expect(listRunnableStage2Tools(ctx.db, t0).map((t) => t.id)).toContain(ext.id);

      // 第 2 次基础设施失败：达到阈值 2，进入 open_circuit
      const f2 = recordStage2ToolFailure(ctx.db, ext.id, "503", t0);
      expect(f2?.healthStatus).toBe("open_circuit");
      expect(f2?.consecutiveFailures).toBe(2);
      expect(f2?.cooldownUntil).toBe("2026-11-24T10:15:00.000Z");

      // 冷却期内被排除
      const t5m = new Date("2026-11-24T10:05:00.000Z");
      expect(listRunnableStage2Tools(ctx.db, t5m).map((t) => t.id)).not.toContain(ext.id);

      // 冷却到期后半开试探放行
      const t16m = new Date("2026-11-24T10:16:00.000Z");
      expect(listRunnableStage2Tools(ctx.db, t16m).map((t) => t.id)).toContain(ext.id);

      // 半开试探再次失败：立即重新延长冷却
      const f3 = recordStage2ToolFailure(ctx.db, ext.id, "502", t16m);
      expect(f3?.healthStatus).toBe("open_circuit");
      expect(f3?.cooldownUntil).toBe("2026-11-24T10:31:00.000Z");

      // 成功后清零恢复
      recordStage2ToolSuccess(ctx.db, ext.id, t16m);
      expect(listRunnableStage2Tools(ctx.db, t16m).map((t) => t.id)).toContain(ext.id);

      // 手动重置熔断
      recordStage2ToolFailure(ctx.db, ext.id, "err", t16m);
      recordStage2ToolFailure(ctx.db, ext.id, "err", t16m);
      const reset = resetStage2ToolCircuit(ctx.db, ext.id, t16m);
      expect(reset?.healthStatus).toBe("healthy");
      expect(reset?.consecutiveFailures).toBe(0);

      expect(deleteStage2Tool(ctx.db, ext.id)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("bulletin_analyses 支持 upsert 与降级标记", () => {
    const ctx = createTestDb();
    try {
      const saved = upsertBulletinAnalysis(ctx.db, {
        bulletinId: "b1",
        triggerSource: "matched",
        status: "succeeded",
        verdict: "recommended",
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        activeToolIds: ["builtin-calculator"],
        stepsUsed: 2,
        toolCallsCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 320,
        answer: {
          verdict: "recommended",
          summary: "好价可入",
          productName: "抽纸 24 包",
          actualTotalPrice: 29.9,
          unitPrice: 1.25,
          unitLabel: "元/包",
          priceFormula: "29.9 / 24 = 1.25",
          orderSteps: ["领券下单"],
          priceComparison: {
            status: "cheaper",
            referencePrice: 39.9,
            source: "本地历史",
            conclusion: "低于近90天均价",
          },
          requirementChecks: [
            { needName: "抽纸", satisfied: true, reason: "符合要求" },
          ],
          risks: [],
        },
        toolTrace: [],
        error: null,
      });

      expect(saved.verdict).toBe("recommended");
      expect(saved.fallbackNotified).toBe(false);

      expect(markAnalysisFallbackNotified(ctx.db, "b1")).toBe(true);
      const reloaded = getBulletinAnalysis(ctx.db, "b1");
      expect(reloaded?.fallbackNotified).toBe(true);
    } finally {
      ctx.close();
    }
  });
});
