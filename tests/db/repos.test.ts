import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import {
  hasActiveRecordInOtherNs,
  insertBulletinIfAbsent,
  listBulletins,
} from "@/lib/db/repos/bulletins";
import { createNeed, listNeedsPage } from "@/lib/db/repos/needs";
import {
  listChannelsPage,
  syncChannelsFromCatalog,
} from "@/lib/db/repos/channels";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  listRecentFailedJobs,
  reclaimExpiredLeases,
} from "@/lib/db/repos/jobs";
import {
  claimDelivery,
  DELIVERY_MAX_ATTEMPTS,
  insertDeliveries,
  markDeliveryResult,
} from "@/lib/db/repos/deliveries";
import { createNotificationIfAbsent } from "@/lib/db/repos/notifications";
import {
  listEvaluationsByBulletin,
  upsertEvaluation,
} from "@/lib/db/repos/evaluations";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import { makeBulletin } from "../helpers/bulletins";
import type { Evaluation } from "@/lib/domain/types";

describe("基线语义（AC4）", () => {
  it("首次快照写基线且不产生任务；再次出现已存在条目不重复插入", () => {
    const ctx = createTestDb();
    try {
      const first = insertBulletinIfAbsent(ctx.db, makeNormalized(), {
        baseline: true,
      });
      expect(first.inserted).toBe(true);
      const again = insertBulletinIfAbsent(ctx.db, makeNormalized(), {
        baseline: false,
      });
      expect(again.inserted).toBe(false);
      expect(again.id).toBe(first.id);
      const listed = listBulletins(ctx.db);
      expect(listed.total).toBe(1);
      expect(listed.items[0].baseline).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("新频道基线化不会降级其它频道已有记录或取消其任务", () => {
    const ctx = createTestDb();
    try {
      const item = makeNormalized({ sourceId: "7208398" });
      const processed = insertBulletinIfAbsent(ctx.db, item, { baseline: false });
      const job = enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: `evaluate:${processed.id}`,
        payload: { bulletinId: processed.id },
      });
      expect(job.created).toBe(true);

      // 另一个频道（不同编号空间）出现同一来源文章并建立基线。
      const otherNs = makeNormalized({ sourceNs: "feed:weibo", sourceId: "7208398" });
      expect(
        hasActiveRecordInOtherNs(ctx.db, otherNs.source, otherNs.sourceId, otherNs.sourceNs),
      ).toBe(true);
      const baselineRow = insertBulletinIfAbsent(ctx.db, otherNs, { baseline: true });
      expect(baselineRow.inserted).toBe(true);

      // 原频道记录与其任务不受影响。
      const original = ctx.db
        .prepare("SELECT baseline FROM bulletins WHERE id = ?")
        .get(processed.id) as { baseline: number };
      expect(original.baseline).toBe(0);
      const jobRow = ctx.db
        .prepare("SELECT status FROM jobs WHERE payload_key = ?")
        .get(`evaluate:${processed.id}`) as { status: string };
      expect(jobRow.status).toBe("pending");
      expect(listBulletins(ctx.db).total).toBe(2);
      expect(
        listBulletins(ctx.db).items.find((b) => b.sourceNs === "feed:weibo")?.baseline,
      ).toBe(true);
    } finally {
      ctx.close();
    }
  });
});

describe("任务队列（AC7/AC11）", () => {
  it("enqueue 幂等", () => {
    const ctx = createTestDb();
    try {
      const a = enqueueJob(ctx.db, { kind: "evaluate", payloadKey: "k", payload: {} });
      const b = enqueueJob(ctx.db, { kind: "evaluate", payloadKey: "k", payload: {} });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("租约过期后归还为 pending", () => {
    const ctx = createTestDb();
    try {
      enqueueJob(ctx.db, { kind: "evaluate", payloadKey: "k", payload: {} });
      const leased = claimJob(ctx.db, "worker", 1000, new Date());
      expect(leased?.status).toBe("leased");
      const reclaimed = reclaimExpiredLeases(ctx.db, new Date(Date.now() + 5000));
      expect(reclaimed).toBe(1);
      expect(getJob(ctx.db, leased!.id)?.status).toBe("pending");
    } finally {
      ctx.close();
    }
  });

  it("超过最大尝试次数置为 dead 并可查询失败任务", () => {
    const ctx = createTestDb();
    try {
      const { id } = enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: "k",
        payload: {},
        maxAttempts: 2,
      });
      claimJob(ctx.db, "w", 1000, new Date());
      failJob(ctx.db, id, "boom", new Date());
      claimJob(ctx.db, "w", 1000, new Date(Date.now() + 10_000));
      const outcome = failJob(ctx.db, id, "boom again", new Date(Date.now() + 20_000));
      expect(outcome.status).toBe("dead");
      expect(listRecentFailedJobs(ctx.db)).toHaveLength(1);
      completeJob(ctx.db, id);
      expect(getJob(ctx.db, id)?.status).toBe("succeeded");
    } finally {
      ctx.close();
    }
  });
});

describe("投递状态（AC9/AC10）", () => {
  function seedDelivery(ctx: ReturnType<typeof createTestDb>) {
    const { notification } = createNotificationIfAbsent(ctx.db, "bulletin-1", {});
    insertDeliveries(ctx.db, [
      { notificationId: notification.id, bulletinId: "bulletin-1", channel: "bark" },
      { notificationId: notification.id, bulletinId: "bulletin-1", channel: "feishu" },
    ]);
    return notification;
  }

  it("已成功投递不会被再次领取（本地重放不重复发送）", () => {
    const ctx = createTestDb();
    try {
      seedDelivery(ctx);
      const first = claimDelivery(ctx.db, "w", 1000, new Date());
      expect(first?.channel).toBe("bark");
      markDeliveryResult(ctx.db, { id: first!.id, status: "succeeded" });
      const second = claimDelivery(ctx.db, "w", 1000, new Date());
      expect(second?.channel).toBe("feishu");
      markDeliveryResult(ctx.db, { id: second!.id, status: "succeeded" });
      expect(claimDelivery(ctx.db, "w", 1000, new Date())).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("一个渠道成功、另一个失败时只重试失败渠道", () => {
    const ctx = createTestDb();
    try {
      seedDelivery(ctx);
      const bark = claimDelivery(ctx.db, "w", 1000, new Date())!;
      markDeliveryResult(ctx.db, { id: bark.id, status: "succeeded" });
      const feishu = claimDelivery(ctx.db, "w", 1000, new Date())!;
      markDeliveryResult(ctx.db, { id: feishu.id, status: "failed", error: "业务码非 0" });

      // 只重试 feishu
      const retry = claimDelivery(ctx.db, "w", 1000, new Date());
      expect(retry?.channel).toBe("feishu");
      markDeliveryResult(ctx.db, { id: retry!.id, status: "succeeded" });
      expect(claimDelivery(ctx.db, "w", 1000, new Date())).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("超过自动重试上限后不再领取", () => {
    const ctx = createTestDb();
    try {
      seedDelivery(ctx);
      const first = claimDelivery(ctx.db, "w", 1000, new Date())!;
      for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i += 1) {
        markDeliveryResult(ctx.db, { id: first.id, status: "failed", error: "x" });
      }
      const next = claimDelivery(ctx.db, "w", 1000, new Date());
      expect(next?.channel).toBe("feishu");
      const later = claimDelivery(ctx.db, "w", 1000, new Date());
      // bark 已超上限，只剩 feishu 被领取后也不再有 bark
      expect(later?.channel ?? "feishu").toBe("feishu");
    } finally {
      ctx.close();
    }
  });
});

describe("通知创建（AC8/AC10）", () => {
  const matched = (name: string): Evaluation => ({
    id: `e-${name}`,
    bulletinId: "bulletin-1",
    needId: `need-${name}`,
    needName: name,
    needNote: "",
    needVersion: 1,
    configVersion: 1,
    ruleVersion: "r",
    result: "matched",
    probabilities: null,
    confidence: 0.9,
    rawAnswer: null,
    error: null,
    attempts: 1,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    modelResult: "matched",
    decisionReason: "matched_confirmed",
    decisionPolicyVersion: "match-confirmation-v1",
    decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
    jevRequestId: null,
  });

  it("两渠道关闭时不创建投递但保留判断/通知", () => {
    const ctx = createTestDb();
    try {
      const result = createNotificationAndDeliveries(
        ctx.db,
        makeBulletin(),
        [matched("抽纸"), matched("厨房纸")],
      );
      expect(result.created).toBe(true);
      expect(result.channels).toEqual([]);
      const count = ctx.db
        .prepare("SELECT COUNT(*) AS c FROM deliveries")
        .get() as { c: number };
      expect(count.c).toBe(0);
      // 多需求合并为一条通知
      const payload = JSON.parse(result.notification.payload) as { needs: string[] };
      expect(payload.needs).toEqual(["抽纸", "厨房纸"]);
    } finally {
      ctx.close();
    }
  });

  it("重复调用不会重复创建通知或投递", () => {
    const ctx = createTestDb();
    try {
      const first = createNotificationAndDeliveries(ctx.db, makeBulletin(), [matched("抽纸")]);
      const second = createNotificationAndDeliveries(ctx.db, makeBulletin(), [matched("抽纸")]);
      expect(second.created).toBe(false);
      expect(second.notification.id).toBe(first.notification.id);
    } finally {
      ctx.close();
    }
  });
});

describe("判断追溯字段（AC5）", () => {
  function seedBulletin(ctx: ReturnType<typeof createTestDb>): string {
    return insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceId: "trace-1" }), {
      baseline: false,
    }).id;
  }

  it("原始概率/置信度/最终结果与追溯快照可往返，策略 JSON 正确解码", () => {
    const ctx = createTestDb();
    try {
      const bulletinId = seedBulletin(ctx);
      upsertEvaluation(ctx.db, {
        bulletinId,
        needId: "need-1",
        needName: "抽纸",
        needNote: "",
        needVersion: 1,
        configVersion: 3,
        ruleVersion: "r1",
        result: "uncertain",
        probabilities: { matched: 0.52, not_matched: 0.15, uncertain: 0.33 },
        confidence: 0.28,
        rawAnswer: '{"choice":"matched"}',
        error: null,
        modelResult: "matched",
        decisionReason: "matched_probability_below_threshold",
        decisionPolicyVersion: "match-confirmation-v1",
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-1",
      });

      const [row] = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(row.result).toBe("uncertain");
      expect(row.modelResult).toBe("matched");
      expect(row.decisionReason).toBe("matched_probability_below_threshold");
      expect(row.decisionPolicyVersion).toBe("match-confirmation-v1");
      expect(row.decisionPolicy).toEqual({
        minMatchedProbability: 0.8,
        probabilitySumTolerance: 0.01,
      });
      expect(row.jevRequestId).toBe("req-1");
      expect(JSON.parse(row.probabilities!)).toEqual({
        matched: 0.52,
        not_matched: 0.15,
        uncertain: 0.33,
      });
      expect(row.confidence).toBe(0.28);
      expect(row.rawAnswer).toBe('{"choice":"matched"}');
      expect(row.error).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("同键重试同步覆盖追溯信息、attempts 累加、created_at 不变", () => {
    const ctx = createTestDb();
    try {
      const bulletinId = seedBulletin(ctx);
      const base = {
        bulletinId,
        needId: "need-1",
        needName: "抽纸",
        needNote: "",
        needVersion: 1,
        configVersion: 1,
        ruleVersion: "r1",
      };
      upsertEvaluation(ctx.db, {
        ...base,
        result: "uncertain",
        modelResult: "matched",
        decisionReason: "probabilities_missing",
        decisionPolicyVersion: "match-confirmation-v1",
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-old",
      });
      const before = listEvaluationsByBulletin(ctx.db, bulletinId)[0];

      upsertEvaluation(ctx.db, {
        ...base,
        result: "matched",
        modelResult: "matched",
        decisionReason: "matched_confirmed",
        decisionPolicyVersion: "match-confirmation-v1",
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-new",
      });
      const after = listEvaluationsByBulletin(ctx.db, bulletinId)[0];
      expect(after.result).toBe("matched");
      expect(after.decisionReason).toBe("matched_confirmed");
      expect(after.jevRequestId).toBe("req-new");
      expect(after.attempts).toBe(2);
      expect(after.createdAt).toBe(before.createdAt);
    } finally {
      ctx.close();
    }
  });

  it("旧行追溯字段为 NULL；异常策略 JSON 解码为 null，不默认为当前策略", () => {
    const ctx = createTestDb();
    try {
      const bulletinId = seedBulletin(ctx);
      const now = new Date().toISOString();
      ctx.db
        .prepare(
          `INSERT INTO evaluations (
             id, bulletin_id, need_id, need_name, need_note, need_version, config_version,
             rule_version, result, attempts, created_at, updated_at
           ) VALUES ('old-1', ?, 'n1', '旧需求', '', 1, 1, 'r0', 'matched', 1, ?, ?)`,
        )
        .run(bulletinId, now, now);
      const [old] = listEvaluationsByBulletin(ctx.db, bulletinId);
      expect(old.modelResult).toBeNull();
      expect(old.decisionReason).toBeNull();
      expect(old.decisionPolicyVersion).toBeNull();
      expect(old.decisionPolicy).toBeNull();
      expect(old.jevRequestId).toBeNull();

      // 异常 JSON 不使详情崩溃，也不回退成默认策略。
      ctx.db
        .prepare("UPDATE evaluations SET decision_policy_json = ? WHERE id = 'old-1'")
        .run("{not-json");
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0].decisionPolicy).toBeNull();
      ctx.db
        .prepare("UPDATE evaluations SET decision_policy_json = ? WHERE id = 'old-1'")
        .run('{"minMatchedProbability":"0.8"}');
      expect(listEvaluationsByBulletin(ctx.db, bulletinId)[0].decisionPolicy).toBeNull();
    } finally {
      ctx.close();
    }
  });
});

describe("服务端分页仓库（total / offset 窗口 / 并列键稳定）", () => {
  it("listNeedsPage 返回 total 与 offset 窗口，越界返回空但保留 total", () => {
    const ctx = createTestDb();
    try {
      for (let i = 0; i < 5; i += 1) createNeed(ctx.db, { name: `需求 ${i}` });

      const first = listNeedsPage(ctx.db, { limit: 2, offset: 0 });
      expect(first.total).toBe(5);
      expect(first.items).toHaveLength(2);

      const last = listNeedsPage(ctx.db, { limit: 2, offset: 4 });
      expect(last.total).toBe(5);
      expect(last.items).toHaveLength(1);

      const beyond = listNeedsPage(ctx.db, { limit: 2, offset: 5 });
      expect(beyond.total).toBe(5);
      expect(beyond.items).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("listNeedsPage 在 created_at 并列时按 id 稳定排序，跨页不重不漏", () => {
    const ctx = createTestDb();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        ids.push(createNeed(ctx.db, { name: `需求 ${i}` }).id);
      }
      // 强制 created_at 完全并列，验证排序追加 id 作为唯一并列键
      ctx.db
        .prepare("UPDATE needs SET created_at = '2026-10-16T00:00:00.000Z'")
        .run();
      const expected = [...ids].sort();

      const collected: string[] = [];
      for (let page = 0; page < 4; page += 1) {
        const slice = listNeedsPage(ctx.db, { limit: 1, offset: page });
        expect(slice.total).toBe(4);
        collected.push(...slice.items.map((item) => item.id));
      }
      expect(collected).toEqual(expected);
      expect(new Set(collected).size).toBe(4);
    } finally {
      ctx.close();
    }
  });

  it("listChannelsPage 返回 total 与 offset 窗口，越界返回空但保留 total", () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [
          { id: "feed-a", name: "手机", alias: "a", origin: "feed" },
          { id: "feed-b", name: "电脑", alias: "b", origin: "feed" },
          { id: "zdm", name: "值得买", alias: null, origin: "zdm" },
        ],
        { mode: "all", customIds: [] },
      );

      const first = listChannelsPage(ctx.db, { limit: 2, offset: 0 });
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(2);
      // origin ASC：feed 在前
      expect(first.items.map((item) => item.origin)).toEqual(["feed", "feed"]);

      const beyond = listChannelsPage(ctx.db, { limit: 2, offset: 3 });
      expect(beyond.total).toBe(3);
      expect(beyond.items).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("listChannelsPage 在 origin/name 并列时按 id 稳定排序，跨页不重不漏", () => {
    const ctx = createTestDb();
    try {
      syncChannelsFromCatalog(
        ctx.db,
        [
          { id: "b", name: "同名", alias: null, origin: "feed" },
          { id: "a", name: "同名", alias: null, origin: "feed" },
          { id: "c", name: "同名", alias: null, origin: "feed" },
        ],
        { mode: "all", customIds: [] },
      );

      const collected: string[] = [];
      for (let page = 0; page < 3; page += 1) {
        const slice = listChannelsPage(ctx.db, { limit: 1, offset: page });
        expect(slice.total).toBe(3);
        collected.push(...slice.items.map((item) => item.id));
      }
      expect(collected).toEqual(["a", "b", "c"]);
      expect(new Set(collected).size).toBe(3);
    } finally {
      ctx.close();
    }
  });
});
