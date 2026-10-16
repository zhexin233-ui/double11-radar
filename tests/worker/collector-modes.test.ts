import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { loadEnv } from "@/lib/env";
import { syncChannelsFromCatalog } from "@/lib/db/repos/channels";
import { createNeed } from "@/lib/db/repos/needs";
import { getJevConfigView, saveJevConfig } from "@/lib/service/config";
import { runCollectorOnce, type CollectorDeps } from "@/lib/worker/collector";
import {
  fetchFeed as xbFetchFeed,
  fetchMeta as xbFetchMeta,
} from "@/lib/sources/xianbao/client";
import {
  FEED_HAODAN_NEW_ITEM,
  FEED_HAODAN_RESPONSE,
  META_RESPONSE,
  ZDM_RESPONSE,
  jsonResponse,
} from "../fixtures/xianbao";

/**
 * 采集事务内的 run / 子批 / 成员创建（AC1/AC3/AC6）。
 *
 * 全部使用固定 fixture 的注入 fetch，不连接真实采集接口。
 */

const KEY = testKey();
const ENV = loadEnv();
const T1 = new Date("2026-10-16T01:00:00.000Z");
const T2 = new Date("2026-10-16T01:02:00.000Z");

const EXTRA_2 = {
  ...FEED_HAODAN_NEW_ITEM,
  id: 9_999_999,
  title: "维达抽纸 18包",
  content: "维达抽纸 18包 19.9元包邮",
  url: "https://new.xianbao.fun/haodan/9999999.html",
};

function feedWith(extras: unknown[]) {
  const items = [...FEED_HAODAN_RESPONSE.data.items, ...extras];
  return {
    ...FEED_HAODAN_RESPONSE,
    data: { ...FEED_HAODAN_RESPONSE.data, count: items.length, items },
  };
}

function makeDeps(extras: unknown[] = []): CollectorDeps {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/meta")) return jsonResponse(META_RESPONSE);
    if (url.includes("type=zdm")) return jsonResponse(ZDM_RESPONSE);
    if (url.includes("cate=haodan")) return jsonResponse(feedWith(extras));
    return jsonResponse({
      code: 0,
      msg: "",
      data: { type: "post", count: 0, items: [] },
      meta: { api_version: "v1", cache_ttl: 10 },
    });
  });
  return {
    fetchMeta: (options = {}) =>
      xbFetchMeta({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }),
    fetchFeed: (channel, options = {}) =>
      xbFetchFeed(channel, {
        ...options,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    requestSpacingMs: 0,
  };
}

type Ctx = ReturnType<typeof createTestDb>;

function seedChannel(ctx: Ctx): void {
  syncChannelsFromCatalog(
    ctx.db,
    [{ id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" }],
    { mode: "custom", customIds: ["haodan"] },
  );
}

async function collectTwoNew(ctx: Ctx): Promise<void> {
  await runCollectorOnce(ctx.db, ENV, { ...makeDeps(), now: () => T1 });
  const second = await runCollectorOnce(ctx.db, ENV, {
    ...makeDeps([FEED_HAODAN_NEW_ITEM, EXTRA_2]),
    now: () => T2,
  });
  expect(second.enqueued).toBeGreaterThan(0);
}

describe("采集事务内创建处理 run（AC1/AC3/AC6）", () => {
  it("默认逐条模式创建 individual run，并为每个新增成员建逐条任务", async () => {
    const ctx = createTestDb();
    try {
      seedChannel(ctx);
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-collect" }, KEY);
      await collectTwoNew(ctx);

      const runs = ctx.db
        .prepare("SELECT * FROM evaluation_runs")
        .all() as Array<{ evaluation_mode: string; regex_rules_json: string | null; need_snapshots_json: string | null }>;
      // 首次基线不建 run；只有第二次采集的新成员产生一条 run。
      expect(runs).toHaveLength(1);
      expect(runs[0].evaluation_mode).toBe("individual");
      expect(runs[0].regex_rules_json).toBeNull();
      expect(runs[0].need_snapshots_json).toBeNull();

      const processing = ctx.db
        .prepare("SELECT stage, batch_part_id FROM bulletin_processing")
        .all() as Array<{ stage: string; batch_part_id: string | null }>;
      expect(processing).toHaveLength(2);
      expect(processing.every((row) => row.stage === "pending" && row.batch_part_id === null)).toBe(true);

      const jobs = ctx.db
        .prepare("SELECT kind, payload FROM jobs ORDER BY created_at")
        .all() as Array<{ kind: string; payload: string }>;
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.kind === "evaluate")).toBe(true);
      for (const job of jobs) {
        const payload = JSON.parse(job.payload) as { evaluationRunId?: string };
        expect(payload.evaluationRunId).toBeTruthy();
      }
    } finally {
      ctx.close();
    }
  });

  it("批次模式按需求快照装箱并建 screen_batch 任务", async () => {
    const ctx = createTestDb();
    try {
      seedChannel(ctx);
      createNeed(ctx.db, { name: "抽纸", note: "不要湿巾" });
      saveJevConfig(
        ctx.db,
        { apiKey: "sk-collect", evaluationMode: "batch_gate" },
        KEY,
      );
      await collectTwoNew(ctx);

      const run = ctx.db
        .prepare("SELECT * FROM evaluation_runs")
        .get() as { evaluation_mode: string; need_snapshots_json: string | null };
      expect(run.evaluation_mode).toBe("batch_gate");
      const snapshots = JSON.parse(run.need_snapshots_json!) as Array<{ name: string }>;
      expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["抽纸"]);

      const parts = ctx.db
        .prepare("SELECT state FROM evaluation_batch_parts")
        .all() as Array<{ state: string }>;
      expect(parts).toHaveLength(1);
      expect(parts[0].state).toBe("pending");

      const jobs = ctx.db
        .prepare("SELECT kind FROM jobs")
        .all() as Array<{ kind: string }>;
      expect(jobs).toEqual([{ kind: "screen_batch" }]);

      const processing = ctx.db
        .prepare("SELECT batch_part_id FROM bulletin_processing")
        .all() as Array<{ batch_part_id: string | null }>;
      expect(processing.every((row) => row.batch_part_id !== null)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("正则模式把规则快照写进 run，供后续逐条预筛使用", async () => {
    const ctx = createTestDb();
    try {
      seedChannel(ctx);
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(
        ctx.db,
        {
          apiKey: "sk-collect",
          evaluationMode: "regex_gate",
          regexRules: ["抽纸|软抽"],
        },
        KEY,
      );
      await collectTwoNew(ctx);

      const run = ctx.db
        .prepare("SELECT evaluation_mode, regex_rules_json FROM evaluation_runs")
        .get() as { evaluation_mode: string; regex_rules_json: string | null };
      expect(run.evaluation_mode).toBe("regex_gate");
      expect(JSON.parse(run.regex_rules_json!)).toEqual(["抽纸|软抽"]);
      expect(getJevConfigView(ctx.db, KEY).config.evaluationMode).toBe("regex_gate");
    } finally {
      ctx.close();
    }
  });
});
