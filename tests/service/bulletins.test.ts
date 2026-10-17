import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import {
  getBulletinDisplayStatus,
  insertBulletinIfAbsent,
} from "@/lib/db/repos/bulletins";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { upsertEvaluation } from "@/lib/db/repos/evaluations";
import { MATCH_CONFIRMATION_POLICY_VERSION } from "@/lib/jev/match-policy";
import { RULE_VERSION } from "@/lib/domain/constants";
import {
  describeBulletin,
  listBulletinDetails,
  parseBulletinListQuery,
} from "@/lib/service/bulletins";
import { HttpError } from "@/lib/http/json";

function seedEvaluation(
  ctx: ReturnType<typeof createTestDb>,
  bulletinId: string,
  result: "matched" | "not_matched" | "uncertain" | "failed",
) {
  upsertEvaluation(ctx.db, {
    bulletinId,
    needId: "need-1",
    needName: "抽纸",
    needNote: "",
    needVersion: 1,
    configVersion: 1,
    ruleVersion: "r1",
    result,
    probabilities: { matched: 0.7 },
    confidence: 0.7,
    rawAnswer: "{}",
    error: result === "failed" ? "模型调用失败" : null,
  });
}

describe("线报状态投影（AC12：故障与「没有匹配」必须可区分）", () => {
  it("基线条目单独显示为已建立基线", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: true });
      const detail = describeBulletin(
        ctx.db,
        ctx.db.prepare("SELECT * FROM bulletins WHERE id = ?").get(id) as never,
      );
      expect(detail.status).toBe("baseline");
    } finally {
      ctx.close();
    }
  });

  it("只有不匹配结果时为「没有匹配」", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      seedEvaluation(ctx, id, "not_matched");
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].status).toBe("not_matched");
      expect(page.items[0].explanation).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("信息不足显示待确认且不生成分类说明", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      seedEvaluation(ctx, id, "uncertain");
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].status).toBe("uncertain");
      expect(page.items[0].matchedNeeds).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("处理失败必须显示为失败，不能被当成没有匹配", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      seedEvaluation(ctx, id, "failed");
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].status).toBe("failed");
      expect(page.items[0].evaluations[0].error).toContain("模型调用失败");
    } finally {
      ctx.close();
    }
  });

  it("明确匹配时给出程序生成的分类说明（非模型理由）", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      seedEvaluation(ctx, id, "matched");
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].status).toBe("matched");
      expect(page.items[0].explanation).toBe("该线报被 Jev 判为符合需求：抽纸");
    } finally {
      ctx.close();
    }
  });

  it("混合历史 matched 与本次降级 uncertain 时整体仍 matched，逐需求原因可区分", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      // 历史（旧规则版本）matched：不重算、不撤销，仍参与聚合。
      upsertEvaluation(ctx.db, {
        bulletinId: id,
        needId: "need-old",
        needName: "历史需求",
        needNote: "",
        needVersion: 1,
        configVersion: 1,
        ruleVersion: "r0",
        result: "matched",
        probabilities: { matched: 1, not_matched: 0, uncertain: 0 },
        confidence: 1,
        rawAnswer: "{}",
        error: null,
        modelResult: "matched",
        decisionReason: "matched_confirmed",
        decisionPolicyVersion: "match-confirmation-v1",
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-old",
      });
      // 本次在新策略下降级的需求：原始选择保留，业务结果与原因分开。
      upsertEvaluation(ctx.db, {
        bulletinId: id,
        needId: "need-cur",
        needName: "本次需求",
        needNote: "",
        needVersion: 1,
        configVersion: 1,
        ruleVersion: "r1",
        result: "uncertain",
        probabilities: { matched: 0.52, not_matched: 0.15, uncertain: 0.33 },
        confidence: 0.28,
        rawAnswer: "{}",
        error: null,
        modelResult: "matched",
        decisionReason: "matched_probability_below_threshold",
        decisionPolicyVersion: "match-confirmation-v1",
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-cur",
      });

      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].status).toBe("matched");
      expect(page.items[0].matchedNeeds).toEqual(["历史需求"]);
      // 跨版本/旧记录 matched → 提示历史判定未按本策略重算。
      expect(page.items[0].hasHistoricalMatched).toBe(true);
      const current = page.items[0].evaluations.find((e) => e.needId === "need-cur");
      expect(current?.result).toBe("uncertain");
      expect(current?.modelResult).toBe("matched");
      expect(current?.decisionReason).toBe("matched_probability_below_threshold");
      expect(current?.error).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("只有当前策略版本的 matched 时不提示历史判定", () => {
    const ctx = createTestDb();
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      upsertEvaluation(ctx.db, {
        bulletinId: id,
        needId: "need-now",
        needName: "当前需求",
        needNote: "",
        needVersion: 1,
        configVersion: 1,
        ruleVersion: RULE_VERSION,
        result: "matched",
        probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
        confidence: 0.9,
        rawAnswer: "{}",
        error: null,
        modelResult: "matched",
        decisionReason: "matched_confirmed",
        decisionPolicyVersion: MATCH_CONFIRMATION_POLICY_VERSION,
        decisionPolicy: { minMatchedProbability: 0.8, probabilitySumTolerance: 0.01 },
        jevRequestId: "req-now",
      });
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].hasHistoricalMatched).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("价格缺失保留为 null，不显示为 0 元", () => {
    const ctx = createTestDb();
    try {
      insertBulletinIfAbsent(
        ctx.db,
        makeNormalized({ price: null, sourceId: "no-price" }),
        { baseline: false },
      );
      const page = listBulletinDetails(ctx.db, { baseline: false });
      expect(page.items[0].bulletin.price).toBeNull();
    } finally {
      ctx.close();
    }
  });
});

/**
 * 记录页状态筛选与分页（AC7）。
 *
 * 状态判定的唯一 owner 是仓库层 SQL；这里验证筛选在分页之前执行、
 * items/total 使用同一判定、失败 job 无 evaluation 也能筛到，以及排序稳定。
 */
describe("记录页状态筛选与分页（AC7）", () => {
  type Ctx = ReturnType<typeof createTestDb>;

  function seedResult(
    ctx: Ctx,
    bulletinId: string,
    result: "matched" | "not_matched" | "uncertain" | "failed",
    needId = "need-1",
  ): void {
    upsertEvaluation(ctx.db, {
      bulletinId,
      needId,
      needName: `需求 ${needId}`,
      needNote: "",
      needVersion: 1,
      configVersion: 1,
      ruleVersion: "r1",
      result,
      probabilities: null,
      confidence: null,
      rawAnswer: "{}",
      error: result === "failed" ? "模型调用失败" : null,
    });
  }

  function seedBulletin(
    ctx: Ctx,
    sourceId: string,
    result?: "matched" | "not_matched" | "uncertain" | "failed",
    baseline = false,
  ): string {
    const { id } = insertBulletinIfAbsent(
      ctx.db,
      makeNormalized({ sourceId, title: `样例 ${sourceId}` }),
      { baseline },
    );
    if (result) seedResult(ctx, id, result);
    return id;
  }

  it("六种展示状态与优先级判定", () => {
    const ctx = createTestDb();
    try {
      const baseline = seedBulletin(ctx, "b-base", undefined, true);
      const pending = seedBulletin(ctx, "b-pending");
      const matched = seedBulletin(ctx, "b-matched", "matched");
      const failed = seedBulletin(ctx, "b-failed", "failed");
      const uncertain = seedBulletin(ctx, "b-uncertain", "uncertain");
      const notMatched = seedBulletin(ctx, "b-not", "not_matched");

      expect(getBulletinDisplayStatus(ctx.db, baseline)).toBe("baseline");
      expect(getBulletinDisplayStatus(ctx.db, pending)).toBe("pending");
      expect(getBulletinDisplayStatus(ctx.db, matched)).toBe("matched");
      expect(getBulletinDisplayStatus(ctx.db, failed)).toBe("failed");
      expect(getBulletinDisplayStatus(ctx.db, uncertain)).toBe("uncertain");
      expect(getBulletinDisplayStatus(ctx.db, notMatched)).toBe("not_matched");

      // 优先级：matched > failed > uncertain > 其它已判断 > pending
      const mixed = seedBulletin(ctx, "b-mixed");
      seedResult(ctx, mixed, "matched", "need-a");
      seedResult(ctx, mixed, "failed", "need-b");
      expect(getBulletinDisplayStatus(ctx.db, mixed)).toBe("matched");

      const failedOver = seedBulletin(ctx, "b-failed-over");
      seedResult(ctx, failedOver, "failed", "need-a");
      seedResult(ctx, failedOver, "uncertain", "need-b");
      expect(getBulletinDisplayStatus(ctx.db, failedOver)).toBe("failed");

      const uncertainOver = seedBulletin(ctx, "b-uncertain-over");
      seedResult(ctx, uncertainOver, "uncertain", "need-a");
      seedResult(ctx, uncertainOver, "not_matched", "need-b");
      expect(getBulletinDisplayStatus(ctx.db, uncertainOver)).toBe("uncertain");
    } finally {
      ctx.close();
    }
  });

  it("evaluate job 失败但未落 evaluation 时也显示为处理失败", () => {
    const ctx = createTestDb();
    try {
      const id = seedBulletin(ctx, "b-job-failed");
      enqueueJob(ctx.db, {
        kind: "evaluate",
        payloadKey: `evaluate:${id}`,
        payload: { bulletinId: id },
      });
      ctx.db
        .prepare(
          "UPDATE jobs SET status = 'dead', last_error = '模型调用失败' WHERE payload_key = ?",
        )
        .run(`evaluate:${id}`);
      expect(getBulletinDisplayStatus(ctx.db, id)).toBe("failed");

      // 成功重试清空 last_error 后回落为 pending（尚无 evaluation）
      ctx.db
        .prepare(
          "UPDATE jobs SET status = 'succeeded', last_error = NULL WHERE payload_key = ?",
        )
        .run(`evaluate:${id}`);
      expect(getBulletinDisplayStatus(ctx.db, id)).toBe("pending");
    } finally {
      ctx.close();
    }
  });

  it("状态筛选在分页之前执行，items 与 total 使用同一定义且排除基线", () => {
    const ctx = createTestDb();
    try {
      for (let i = 0; i < 55; i += 1) seedBulletin(ctx, `m-${i}`, "matched");
      for (let i = 0; i < 5; i += 1) seedBulletin(ctx, `f-${i}`, "failed");
      // 基线条目即使有 matched 判断也必须被 baseline:false 排除
      seedBulletin(ctx, "base-1", "matched", true);

      const page1 = listBulletinDetails(ctx.db, {
        status: "matched",
        limit: 50,
        offset: 0,
        baseline: false,
      });
      expect(page1.total).toBe(55);
      expect(page1.items).toHaveLength(50);
      expect(page1.items.every((item) => item.status === "matched")).toBe(true);

      const page2 = listBulletinDetails(ctx.db, {
        status: "matched",
        limit: 50,
        offset: 50,
        baseline: false,
      });
      expect(page2.total).toBe(55);
      expect(page2.items).toHaveLength(5);
      expect(page2.items.every((item) => item.status === "matched")).toBe(true);

      const failedPage = listBulletinDetails(ctx.db, {
        status: "failed",
        limit: 50,
        offset: 0,
        baseline: false,
      });
      expect(failedPage.total).toBe(5);
      expect(failedPage.items.every((item) => item.status === "failed")).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("解析列表查询参数：缺省全部、非法 status 抛中文错误、limit/offset 回退", () => {
    const empty = parseBulletinListQuery(new URLSearchParams());
    expect(empty.status).toBeUndefined();
    expect(empty.limit).toBe(50);
    expect(empty.offset).toBe(0);
    expect(empty.baseline).toBe(false);

    expect(
      parseBulletinListQuery(new URLSearchParams({ status: "matched" })).status,
    ).toBe("matched");

    const fallback = parseBulletinListQuery(
      new URLSearchParams({ limit: "abc", offset: "x" }),
    );
    expect(fallback.limit).toBe(50);
    expect(fallback.offset).toBe(0);

    const parsed = parseBulletinListQuery(
      new URLSearchParams({ limit: "10", offset: "20" }),
    );
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20);

    let caught: unknown;
    try {
      parseBulletinListQuery(new URLSearchParams({ status: "bogus" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe("INVALID_BODY");
    expect((caught as Error).message).toMatch(/[\u4e00-\u9fff]/);
  });

  it("同一发布时间按 id 倒序稳定排序", () => {
    const ctx = createTestDb();
    try {
      const ids = [
        seedBulletin(ctx, "s-1"),
        seedBulletin(ctx, "s-2"),
        seedBulletin(ctx, "s-3"),
      ];
      const page = listBulletinDetails(ctx.db, { baseline: false, limit: 50, offset: 0 });
      const returned = page.items.map((item) => item.bulletin.id);
      expect(returned).toEqual([...ids].sort().reverse());
    } finally {
      ctx.close();
    }
  });
});
