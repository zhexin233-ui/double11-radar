import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { upsertEvaluation } from "@/lib/db/repos/evaluations";
import { describeBulletin, listBulletinDetails } from "@/lib/service/bulletins";

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
