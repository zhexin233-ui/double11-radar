import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/db";
import { loadEnv } from "@/lib/env";
import { getChannel, saveChannelSelection, setChannelInitialized, syncChannelsFromCatalog } from "@/lib/db/repos/channels";
import { patchRuntimeState } from "@/lib/worker/runtime-state";
import { runCollectorOnce } from "@/lib/worker/collector";
import { fetchFeed, fetchMeta } from "@/lib/sources/xianbao/client";
import { FEED_HAODAN_RESPONSE, META_RESPONSE, jsonResponse } from "../fixtures/xianbao";

// mock 传输验证整条分类校验链路，不连接真实上游。
describe("分类校验与旧频道元数据恢复（R1/R2/R3）", () => {
  it("错误全站响应不入库、不建立评估任务，正确空分类可正常恢复", async () => {
    const ctx = createTestDb();
    try {
      saveChannelSelection(ctx.db, { mode: "custom", customIds: ["haodan"] });
      const now = new Date("2026-10-29T00:00:00.000Z");
      syncChannelsFromCatalog(ctx.db, [{ id: "haodan", alias: "haodan", name: "好单", origin: "feed", categoryId: 30 }]);
      setChannelInitialized(ctx.db, "haodan", true);
      patchRuntimeState(ctx.db, { lastMetaSyncAt: now.toISOString() });
      let wrong = true;
      const transport = vi.fn(async () => jsonResponse({ ...FEED_HAODAN_RESPONSE,
        data: wrong ? { ...FEED_HAODAN_RESPONSE.data, category: { id: 0, alias: "all" } }
          : { category: { id: 30 }, items: [] },
      }));
      const deps = { fetchFeed: (channel: Parameters<typeof fetchFeed>[0]) => fetchFeed(channel, { fetchImpl: transport }),
        requestSpacingMs: 0 };
      expect((await runCollectorOnce(ctx.db, loadEnv(), { ...deps, now: () => now })).errors).toBe(1);
      for (const table of ["bulletins", "jobs", "evaluations", "notifications", "deliveries"]) {
        expect(ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 });
      }
      expect(getChannel(ctx.db, "haodan")?.lastError).toContain("分类与请求不一致");
      wrong = false;
      expect((await runCollectorOnce(ctx.db, loadEnv(), { ...deps,
        now: () => new Date(now.getTime() + 120_000),
      })).errors).toBe(0);
      expect(getChannel(ctx.db, "haodan")?.lastError).toBeNull();
    } finally { ctx.close(); }
  });

  it("旧频道缺 ID 时立即刷新，即使刚同步过；失败不会每两秒重刷", async () => {
    const ctx = createTestDb();
    try {
      saveChannelSelection(ctx.db, { mode: "custom", customIds: ["haodan"] });
      syncChannelsFromCatalog(ctx.db, [{ id: "haodan", alias: "haodan", name: "好单", origin: "feed" }]);
      setChannelInitialized(ctx.db, "haodan", true);
      const t = new Date("2026-10-29T00:00:00.000Z");
      patchRuntimeState(ctx.db, { lastMetaSyncAt: t.toISOString() });
      let failMeta = true;
      const transport = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("/meta")) return failMeta ? new Response("", { status: 500 }) : jsonResponse(META_RESPONSE);
        return jsonResponse({ code: 0, data: { category: { id: 30 }, items: [] } });
      });
      const deps = {
        fetchMeta: () => fetchMeta({ fetchImpl: transport }),
        fetchFeed: (c: Parameters<typeof fetchFeed>[0]) => fetchFeed(c, { fetchImpl: transport }),
        requestSpacingMs: 0,
      };
      await runCollectorOnce(ctx.db, loadEnv(), { ...deps, now: () => t });
      await runCollectorOnce(ctx.db, loadEnv(), { ...deps, now: () => new Date(t.getTime() + 2000) });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(getChannel(ctx.db, "haodan")).toMatchObject({ categoryId: null, initialized: true, selected: true });
      failMeta = false;
      expect((await runCollectorOnce(ctx.db, loadEnv(), { ...deps, now: () => new Date(t.getTime() + 120_000) })).metaSynced).toBe(true);
      expect(getChannel(ctx.db, "haodan")).toMatchObject({ categoryId: 30, initialized: true, selected: true });
      expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM jobs").get()).toEqual({ c: 0 });
    } finally { ctx.close(); }
  });
});
