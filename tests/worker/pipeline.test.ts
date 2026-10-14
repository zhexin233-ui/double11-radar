import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { loadEnv, type AppEnv } from "@/lib/env";
import { syncChannelsFromCatalog } from "@/lib/db/repos/channels";
import { createNeed, listNeeds } from "@/lib/db/repos/needs";
import { listBulletins, insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { listDeliveriesByBulletin } from "@/lib/db/repos/deliveries";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { makeNormalized } from "../helpers/bulletins";
import { getRuntimeState } from "@/lib/worker/runtime-state";
import {
  runCollectorOnce,
  type CollectorDeps,
} from "@/lib/worker/collector";
import { runEvaluatorOnce } from "@/lib/worker/evaluator";
import { runDelivererOnce } from "@/lib/worker/deliverer";
import { saveJevConfig, saveNotifyConfig } from "@/lib/service/config";
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
 * worker 端到端流程：全部外部请求使用注入的假 fetch，**不做真实网络调用**。
 * 因此这里只证明流程与状态转换，不代表真实线报酷/Jev/Bark/飞书接口已验证。
 */

const KEY = testKey();
const ENV: AppEnv = loadEnv();

function feedResponse(extra?: typeof FEED_HAODAN_NEW_ITEM) {
  const items = extra
    ? [...FEED_HAODAN_RESPONSE.data.items, extra]
    : [...FEED_HAODAN_RESPONSE.data.items];
  return {
    ...FEED_HAODAN_RESPONSE,
    data: { ...FEED_HAODAN_RESPONSE.data, count: items.length, items },
  };
}

function makeCollectorDeps(extra?: typeof FEED_HAODAN_NEW_ITEM): {
  deps: CollectorDeps;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/meta")) return jsonResponse(META_RESPONSE);
    if (url.includes("type=zdm")) return jsonResponse(ZDM_RESPONSE);
    if (url.includes("cate=haodan")) return jsonResponse(feedResponse(extra));
    return jsonResponse({
      code: 0,
      msg: "",
      data: { type: "post", count: 0, items: [] },
      meta: { api_version: "v1", cache_ttl: 10 },
    });
  });
  return {
    fetchImpl,
    deps: {
      fetchMeta: (options = {}) =>
        xbFetchMeta({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }),
      fetchFeed: (channel, options = {}) =>
        xbFetchFeed(channel, {
          ...options,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      requestSpacingMs: 0,
    },
  };
}

describe("worker 采集基线与恢复（AC4/AC12）", () => {
  it("首次快照只建立基线，不调用模型也不通知；重启不重新回推", async () => {
    const ctx = createTestDb();
    try {
      const t1 = new Date("2026-10-14T01:00:00.000Z");
      const first = makeCollectorDeps();
      const round1 = await runCollectorOnce(ctx.db, ENV, {
        ...first.deps,
        now: () => t1,
      });
      expect(round1.baseline).toBeGreaterThan(0);
      expect(round1.enqueued).toBe(0);
      const jobs = ctx.db.prepare("SELECT COUNT(*) AS c FROM jobs").get() as { c: number };
      expect(jobs.c).toBe(0);
      expect(listBulletins(ctx.db).items.every((b) => b.baseline)).toBe(true);
      const channels = ctx.db
        .prepare("SELECT id, initialized FROM channels")
        .all() as Array<{ id: string; initialized: number }>;
      expect(channels.every((c) => c.initialized === 1)).toBe(true);

      // 重启后（新连接、同库）同一快照不产生任务
      const round2 = await runCollectorOnce(ctx.db, ENV, {
        ...makeCollectorDeps().deps,
        now: () => new Date(t1.getTime() + 60_000),
      });
      expect(round2.baseline).toBe(0);
      expect(round2.enqueued).toBe(0);

      // 出现新条目才入队
      const round3 = await runCollectorOnce(ctx.db, ENV, {
        ...makeCollectorDeps(FEED_HAODAN_NEW_ITEM).deps,
        now: () => new Date(t1.getTime() + 120_000),
      });
      expect(round3.baseline).toBe(0);
      expect(round3.enqueued).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("单个频道失败不影响其它频道，并记录该频道的错误状态", async () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [
          { id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" },
          { id: "weibo", name: "微博线报", alias: "weibo", origin: "feed" },
        ],
        { mode: "custom", customIds: ["haodan", "weibo"] },
      );
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/meta")) return jsonResponse(META_RESPONSE);
        if (url.includes("cate=haodan")) {
          return new Response("", { status: 500 });
        }
        return jsonResponse(feedResponse());
      });
      const deps: CollectorDeps = {
        fetchMeta: (options = {}) =>
          xbFetchMeta({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch }),
        fetchFeed: (channel, options = {}) =>
          xbFetchFeed(channel, {
            ...options,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          }),
        requestSpacingMs: 0,
        now: () => new Date("2026-10-14T01:00:00.000Z"),
      };
      const result = await runCollectorOnce(ctx.db, ENV, deps);
      expect(result.errors).toBe(1);
      const haodan = ctx.db
        .prepare("SELECT initialized, last_error FROM channels WHERE id = 'haodan'")
        .get() as { initialized: number; last_error: string | null };
      expect(haodan.initialized).toBe(0);
      expect(haodan.last_error).toContain("500");
      const weibo = ctx.db
        .prepare("SELECT initialized FROM channels WHERE id = 'weibo'")
        .get() as { initialized: number };
      expect(weibo.initialized).toBe(1);
      expect(getRuntimeState(ctx.db).lastCollectAt).not.toBeNull();
    } finally {
      ctx.close();
    }
  });
});

describe("worker 判断与投递（mock 传输层，未做真实接口验证）", () => {
  async function seedEvaluated(
    ctx: ReturnType<typeof createTestDb>,
  ): Promise<{ bulletinId: string }> {
    syncChannelsFromCatalog(
      ctx.db,
      [{ id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" }],
      { mode: "custom", customIds: ["haodan"] },
    );
    createNeed(ctx.db, { name: "抽纸", note: "不要湿巾" });
    saveJevConfig(ctx.db, { apiKey: "sk-test" }, KEY);
    saveNotifyConfig(
      ctx.db,
      {
        bark: { enabled: true, deviceKey: "device-key" },
        feishu: { enabled: true, webhook: "https://open.feishu.cn/hook" },
      },
      KEY,
    );

    const t1 = new Date("2026-10-14T01:00:00.000Z");
    await runCollectorOnce(ctx.db, ENV, {
      ...makeCollectorDeps().deps,
      now: () => t1,
    });
    const second = await runCollectorOnce(ctx.db, ENV, {
      ...makeCollectorDeps(FEED_HAODAN_NEW_ITEM).deps,
      now: () => new Date(t1.getTime() + 120_000),
    });
    expect(second.enqueued).toBe(1);

    const callSystemOne = vi.fn(
      async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "choice", choice: "matched" },
          ]),
        ),
      }),
    );
    const evaluate = await runEvaluatorOnce(ctx.db, ENV, {
      callSystemOne: callSystemOne as never,
    });
    expect(evaluate.matched).toBe(1);

    const evaluated = listBulletins(ctx.db).items.find(
      (b) => listEvaluationsByBulletin(ctx.db, b.id).length > 0,
    );
    expect(evaluated).toBeDefined();
    return { bulletinId: evaluated!.id };
  }

  it("命中需求生成一条通知与两个渠道投递，且只重试失败渠道", async () => {
    const ctx = createTestDb();
    try {
      const { bulletinId } = await seedEvaluated(ctx);

      const evaluations = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].result).toBe("matched");
      expect(evaluations[0].needName).toBe("抽纸");
      expect(evaluations[0].error).toBeNull();
      expect(listDeliveriesByBulletin(ctx.db, bulletinId).map((d) => d.channel).sort()).toEqual([
        "bark",
        "feishu",
      ]);

      const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("api.day.app")
          ? jsonResponse({ code: 200 })
          : jsonResponse({ code: 11232, msg: "rate limited" }),
      );
      const delivered = await runDelivererOnce(ctx.db, ENV, { fetchImpl });
      expect(delivered.succeeded).toBe(1);
      expect(delivered.failed).toBe(1);

      const after = listDeliveriesByBulletin(ctx.db, bulletinId);
      expect(after.find((d) => d.channel === "bark")?.status).toBe("succeeded");
      const feishu = after.find((d) => d.channel === "feishu");
      expect(feishu?.status).toBe("failed");
      expect(feishu?.bizCode).toBe("11232");

      // 重试轮需要等到退避时间之后；同一轮内不会反复重发同一渠道。
      const retryNow = new Date(Date.now() + 10_000);
      const retryFetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("api.day.app")) {
          throw new Error("Bark 不应被再次调用");
        }
        return jsonResponse({ code: 0, msg: "success" });
      });
      const retried = await runDelivererOnce(ctx.db, ENV, {
        fetchImpl: retryFetch,
        now: () => retryNow,
      });
      expect(retried.succeeded).toBe(1);
      expect(retryFetch).toHaveBeenCalledTimes(1);
      expect(
        listDeliveriesByBulletin(ctx.db, bulletinId).every(
          (d) => d.status === "succeeded",
        ),
      ).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("无法判定与处理失败严格区分，不伪造命中", async () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [{ id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" }],
        { mode: "custom", customIds: ["haodan"] },
      );
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-test" }, KEY);

      const t1 = new Date("2026-10-14T01:00:00.000Z");
      await runCollectorOnce(ctx.db, ENV, { ...makeCollectorDeps().deps, now: () => t1 });
      await runCollectorOnce(ctx.db, ENV, {
        ...makeCollectorDeps(FEED_HAODAN_NEW_ITEM).deps,
        now: () => new Date(t1.getTime() + 120_000),
      });

      // uncertain 只保留待确认记录，不创建通知/投递
      const uncertainCall = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              { type: "choice", choice: "uncertain" },
            ]),
          ),
        }),
      );
      const uncertain = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: uncertainCall as never,
      });
      expect(uncertain.matched).toBe(0);
      expect(uncertain.uncertain).toBe(1);
      const evaluatedId = listBulletins(ctx.db).items.find(
        (b) => listEvaluationsByBulletin(ctx.db, b.id).length > 0,
      )!.id;
      expect(listEvaluationsByBulletin(ctx.db, evaluatedId)[0].result).toBe("uncertain");
      expect(listDeliveriesByBulletin(ctx.db, evaluatedId)).toHaveLength(0);
      const notificationCount = ctx.db
        .prepare("SELECT COUNT(*) AS c FROM notifications")
        .get() as { c: number };
      expect(notificationCount.c).toBe(0);

      // 结构不合法（未知 choice）记为 failed，同样不通知
      const invalidBulletin = insertBulletinIfAbsent(
        ctx.db,
        makeNormalized({ sourceId: "999", sourceNs: "feed:haodan", title: "未知结果样例" }),
        { baseline: false },
      );
      enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: `evaluate:${invalidBulletin.id}`,
        payload: { bulletinId: invalidBulletin.id },
      });
      const invalidCall = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, { type: "choice", choice: "maybe" }]),
          ),
        }),
      );
      const invalid = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: invalidCall as never,
      });
      expect(invalid.failed).toBe(1);
      expect(
        listEvaluationsByBulletin(ctx.db, invalidBulletin.id)[0].result,
      ).toBe("failed");
      expect(listDeliveriesByBulletin(ctx.db, invalidBulletin.id)).toHaveLength(0);
      const notificationsAfter = ctx.db
        .prepare("SELECT COUNT(*) AS c FROM notifications")
        .get() as { c: number };
      expect(notificationsAfter.c).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("未配置 Jev 时判断失败可重试，不伪造命中", async () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [{ id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" }],
        { mode: "custom", customIds: ["haodan"] },
      );
      createNeed(ctx.db, { name: "抽纸" });
      const t1 = new Date("2026-10-14T01:00:00.000Z");
      await runCollectorOnce(ctx.db, ENV, { ...makeCollectorDeps().deps, now: () => t1 });
      await runCollectorOnce(ctx.db, ENV, {
        ...makeCollectorDeps(FEED_HAODAN_NEW_ITEM).deps,
        now: () => new Date(t1.getTime() + 120_000),
      });

      const result = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: vi.fn() as never,
      });
      expect(result.matched).toBe(0);
      const job = ctx.db
        .prepare("SELECT status, attempts, last_error FROM jobs LIMIT 1")
        .get() as { status: string; attempts: number; last_error: string };
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(1);
      expect(job.last_error).toContain("Jev 未配置");
      // 配置问题走永久重试：下次尝试时间被推迟而不是置 dead
      const runAt = (
        ctx.db.prepare("SELECT run_at FROM jobs LIMIT 1").get() as { run_at: string }
      ).run_at;
      expect(new Date(runAt).getTime()).toBeGreaterThan(Date.parse("2026-10-14T01:00:00.000Z"));
      expect(listNeeds(ctx.db)).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });
});

describe("配置错误的判断任务可自动恢复（AC12）", () => {
  it("Jev 未配置时任务不置 dead，配置正确后会再次尝试", async () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [{ id: "haodan", name: "好单线报", alias: "haodan", origin: "feed" }],
        { mode: "custom", customIds: ["haodan"] },
      );
      createNeed(ctx.db, { name: "抽纸" });
      const t1 = new Date("2026-10-14T01:00:00.000Z");
      await runCollectorOnce(ctx.db, ENV, { ...makeCollectorDeps().deps, now: () => t1 });
      await runCollectorOnce(ctx.db, ENV, {
        ...makeCollectorDeps(FEED_HAODAN_NEW_ITEM).deps,
        now: () => new Date(t1.getTime() + 120_000),
      });

      // 反复失败远超 max_attempts，但因为是配置问题，任务必须保持 pending 而不是 dead
      let at = new Date(t1.getTime() + 200_000);
      for (let i = 0; i < 8; i += 1) {
        await runEvaluatorOnce(ctx.db, ENV, {
          callSystemOne: vi.fn() as never,
          now: () => at,
        });
        at = new Date(at.getTime() + 10 * 60_000);
      }
      const job = ctx.db
        .prepare("SELECT status, attempts, last_error FROM jobs LIMIT 1")
        .get() as { status: string; attempts: number; last_error: string };
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(8);
      expect(job.last_error).toContain("Jev 未配置");

      // 配置好 Jev（此处仍用 mock 传输层成功返回）后，同一任务能被再次领取并完成
      saveJevConfig(ctx.db, { apiKey: "sk-configured" }, KEY);
      const callSystemOne = vi.fn(
        async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              { type: "choice", choice: "matched" },
            ]),
          ),
        }),
      );
      const recovered = await runEvaluatorOnce(ctx.db, ENV, {
        callSystemOne: callSystemOne as never,
        now: () => at,
      });
      expect(recovered.matched).toBe(1);
      const after = ctx.db
        .prepare("SELECT status FROM jobs LIMIT 1")
        .get() as { status: string };
      expect(after.status).toBe("succeeded");
    } finally {
      ctx.close();
    }
  });
});
