import { describe, expect, it } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { addJevKey } from "@/lib/service/jev-keys";
import {
  getJevUsageView,
  JE_PURPOSE_LABELS,
  JE_REQUEST_STATUS_LABELS,
} from "@/lib/service/jev-usage";
import {
  completeJevRequest,
  insertInFlightRequest,
} from "@/lib/db/repos/jev-requests";

/**
 * 费用统计网页投影（AC5/AC6）。
 *
 * 只构造账本数据；不连接真实上游。断言已知金额、未知数量、分 Key 汇总与分页，
 * 并确保未知费用不会以 $0 呈现。
 */

const KEY = testKey();

type Db = ReturnType<typeof createTestDb>["db"];

function insertLedger(
  db: Db,
  keyId: string,
  keyLabel: string,
  generation: number,
  startedAt: Date,
): string {
  return insertInFlightRequest(db, {
    keyId,
    keyLabel,
    keyGeneration: generation,
    purpose: "evaluate",
    requestedModel: "jev-latest",
    providerOrigin: "https://api.typesafe.ai",
    configVersion: 1,
    startedAt,
    leaseUntil: new Date(startedAt.getTime() + 60_000),
  }).id;
}

describe("费用统计投影（AC5/AC6）", () => {
  it("已知/未知/失败分别汇总，未知不显示为 $0，最近调用按时间倒序并支持分页", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "主密钥", apiKey: "sk-a" }, KEY);
      const base = new Date("2026-10-14T00:00:00.000Z");

      // 已知：1,000,000 输入 + jev-1.13.0 + 官方 provider
      const knownId = insertLedger(
        ctx.db,
        key.id,
        key.label,
        key.generation,
        new Date(base.getTime() + 1_000),
      );
      completeJevRequest(ctx.db, {
        id: knownId,
        status: "succeeded",
        now: base,
        responseModel: "jev-1.13.0",
        inputTokens: 1_000_000,
      });

      // 未知：模型未核实（同时是一条处理失败）
      const unknownId = insertLedger(
        ctx.db,
        key.id,
        key.label,
        key.generation,
        new Date(base.getTime() + 2_000),
      );
      completeJevRequest(ctx.db, {
        id: unknownId,
        status: "failed",
        now: base,
        responseModel: "jev-unknown",
        inputTokens: null,
        errorMessage: "模型调用失败",
      });

      const view = getJevUsageView(ctx.db, { limit: 20, offset: 0 });
      expect(view.summary.knownCostUsd).toBe("0.042");
      expect(view.summary.knownCostNanos).toBe(42_000_000);
      expect(view.summary.knownRequestCount).toBe(1);
      expect(view.summary.unknownCostCount).toBe(1);
      expect(view.summary.failedCount).toBe(1);
      expect(view.summary.totalRequests).toBe(2);
      expect(view.summary.statsStartedAt).not.toBeNull();
      expect(view.summary.inputTokensKnown).toBe(1_000_000);

      const byKey = view.byKey.find((row) => row.keyId === key.id);
      expect(byKey).toBeDefined();
      expect(byKey!.knownCostUsd).toBe("0.042");
      expect(byKey!.requestCount).toBe(2);
      expect(byKey!.unknownCostCount).toBe(1);
      expect(byKey!.failedCount).toBe(1);
      expect(byKey!.inputTokens).toBe(1_000_000);

      // 最近调用按 started_at 倒序：后插入的未知行在前
      expect(view.recent.total).toBe(2);
      expect(view.recent.items).toHaveLength(2);
      expect(view.recent.items[0].id).toBe(unknownId);
      expect(view.recent.items[1].id).toBe(knownId);
      expect(view.recent.items[1].purposeLabel).toBe(JE_PURPOSE_LABELS.evaluate);
      expect(view.recent.items[0].statusLabel).toBe(
        JE_REQUEST_STATUS_LABELS.failed,
      );

      const unknownView = view.recent.items.find((item) => item.id === unknownId)!;
      expect(unknownView.estimatedUsd).toBeNull();
      expect(unknownView.estimatedUsdNanos).toBeNull();
      expect(unknownView.unknownReason).toMatch(/[\u4e00-\u9fff]/);

      const knownView = view.recent.items.find((item) => item.id === knownId)!;
      expect(knownView.estimatedUsd).toBe("0.042");
      expect(knownView.estimatedUsdNanos).toBe(42_000_000);

      // 分页：limit/offset 与 total 一致
      const page1 = getJevUsageView(ctx.db, { limit: 1, offset: 0 });
      expect(page1.recent.total).toBe(2);
      expect(page1.recent.items).toHaveLength(1);
      expect(page1.recent.items[0].id).toBe(unknownId);

      const page2 = getJevUsageView(ctx.db, { limit: 1, offset: 1 });
      expect(page2.recent.total).toBe(2);
      expect(page2.recent.items[0].id).toBe(knownId);
    } finally {
      ctx.close();
    }
  });

  it("非整数分页参数不会 500，回退后仍能取到数据（AC5；核验 P1 修复）", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "分页密钥", apiKey: "sk-page" }, KEY);
      const startedAt = new Date("2026-10-14T03:00:00.000Z");
      const id = insertLedger(ctx.db, key.id, key.label, key.generation, startedAt);
      completeJevRequest(ctx.db, {
        id,
        status: "succeeded",
        now: new Date(startedAt.getTime() + 1_000),
        responseModel: "jev-1.13.0",
        inputTokens: 1_000,
        outputTokens: null,
      });

      // SQLite 的 LIMIT/OFFSET 只接受整数；小数/NaN 必须被夹成合法值而不是抛错。
      const fractional = getJevUsageView(ctx.db, { limit: 1.5, offset: 2.7 });
      expect(fractional.recent.total).toBe(1);
      expect(fractional.recent.items).toHaveLength(0);

      const bogus = getJevUsageView(ctx.db, { limit: Number.NaN, offset: Number.NaN });
      expect(bogus.recent.total).toBe(1);
      expect(bogus.recent.items).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("按 Key 汇总区分已计价与进行中：in_flight 不计已计价也不计未知（AC5/AC6）", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "进行中密钥", apiKey: "sk-flight" }, KEY);
      insertLedger(
        ctx.db,
        key.id,
        key.label,
        key.generation,
        new Date("2026-10-14T04:00:00.000Z"),
      );

      const view = getJevUsageView(ctx.db);
      expect(view.summary.pendingCount).toBe(1);
      expect(view.summary.knownRequestCount).toBe(0);

      const row = view.byKey[0];
      expect(row.requestCount).toBe(1);
      // in_flight 既不算「已计价」也不算「费用未知」：页面据此显示「—」而不是 $0.00。
      expect(row.knownRequestCount).toBe(0);
      expect(row.unknownCostCount).toBe(0);
      expect(row.knownCostUsd).toBe("0.00");
    } finally {
      ctx.close();
    }
  });
});
