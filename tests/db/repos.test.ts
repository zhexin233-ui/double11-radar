import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import {
  hasActiveRecordInOtherNs,
  insertBulletinIfAbsent,
  listBulletins,
} from "@/lib/db/repos/bulletins";
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
