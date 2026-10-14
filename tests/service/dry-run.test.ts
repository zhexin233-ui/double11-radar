import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { createNeed, updateNeed } from "@/lib/db/repos/needs";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { runJevDryRun } from "@/lib/service/dry-run";
import { saveJevConfig } from "@/lib/service/config";
import { JevError } from "@/lib/jev/client";
import { questionIdForNeed } from "@/lib/jev/prompt";

const KEY = testKey();

function answering(choiceFor: (questionId: string) => unknown) {
  return vi.fn(
    async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, choiceFor(id)]),
      ),
    }),
  );
}

describe("需求试判 dry-run（验收工具，不写库）", () => {
  it("逐需求返回三态结果，且不写入任何判断/通知/投递记录", async () => {
    const ctx = createTestDb();
    try {
      const paper = createNeed(ctx.db, { name: "抽纸", note: "不要湿巾" });
      const coffee = createNeed(ctx.db, { name: "咖啡豆" });
      saveJevConfig(ctx.db, { apiKey: "sk-dry-run" }, KEY);

      const callSystemOne = answering((id) =>
        id === questionIdForNeed(paper.id)
          ? { type: "choice", choice: "matched", confidence: 0.91 }
          : { type: "choice", choice: "not_matched" },
      );

      const result = await runJevDryRun(
        ctx.db,
        { title: "心相印超韧抽纸 24包", content: "9.9元包邮" },
        { callSystemOne: callSystemOne as never },
      );

      expect(result.needsCount).toBe(2);
      expect(result.results).toHaveLength(2);
      const byName = Object.fromEntries(result.results.map((r) => [r.needName, r]));
      expect(byName["抽纸"].result).toBe("matched");
      expect(byName["抽纸"].confidence).toBe(0.91);
      expect(byName["抽纸"].needNote).toBe("不要湿巾");
      expect(byName["咖啡豆"].result).toBe("not_matched");

      // 不写任何判断/通知/投递记录
      expect(
        (ctx.db.prepare("SELECT COUNT(*) c FROM evaluations").get() as { c: number }).c,
      ).toBe(0);
      expect(
        (ctx.db.prepare("SELECT COUNT(*) c FROM notifications").get() as { c: number }).c,
      ).toBe(0);
      expect(
        (ctx.db.prepare("SELECT COUNT(*) c FROM deliveries").get() as { c: number }).c,
      ).toBe(0);
      expect(
        (ctx.db.prepare("SELECT COUNT(*) c FROM jobs").get() as { c: number }).c,
      ).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("价格留空按「来源未提供」传入，不会变成 0 元", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-dry-run" }, KEY);
      const callSystemOne = answering(() => ({ type: "choice", choice: "uncertain" }));

      await runJevDryRun(ctx.db, { title: "心相印9.9元" }, { callSystemOne: callSystemOne as never });

      const [, request] = callSystemOne.mock.calls[0] as unknown as [
        unknown,
        { state: string },
      ];
      const state = JSON.parse(request.state) as Record<string, unknown>;
      expect(state["线报标题"]).toBe("心相印9.9元");
      expect("价格" in state).toBe(false);
      expect("正文" in state).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("沿用生产的严格解析：未知 choice 记为处理失败", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-dry-run" }, KEY);
      const result = await runJevDryRun(
        ctx.db,
        { title: "样例" },
        {
          callSystemOne: answering(() => ({ type: "choice", choice: "maybe" })) as never,
        },
      );
      expect(result.results[0].result).toBe("failed");
      expect(result.results[0].error).toContain("未知");
    } finally {
      ctx.close();
    }
  });

  it("Jev 未配置时抛出可识别的配置错误，不发起调用", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      const callSystemOne = vi.fn();
      await expect(
        runJevDryRun(ctx.db, { title: "样例" }, { callSystemOne: callSystemOne as never }),
      ).rejects.toBeInstanceOf(JevError);
      expect(callSystemOne).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });

  it("没有启用需求时直接返回空结果，不调用 Jev", async () => {
    const ctx = createTestDb();
    try {
      const need = createNeed(ctx.db, { name: "抽纸" });
      updateNeed(ctx.db, need.id, { enabled: false });
      saveJevConfig(ctx.db, { apiKey: "sk-dry-run" }, KEY);
      const callSystemOne = vi.fn();
      const result = await runJevDryRun(
        ctx.db,
        { title: "样例" },
        { callSystemOne: callSystemOne as never },
      );
      expect(result.needsCount).toBe(0);
      expect(result.results).toEqual([]);
      expect(callSystemOne).not.toHaveBeenCalled();
    } finally {
      ctx.close();
    }
  });

  it("试判不会污染已有判断记录", async () => {
    const ctx = createTestDb();
    try {
      createNeed(ctx.db, { name: "抽纸" });
      saveJevConfig(ctx.db, { apiKey: "sk-dry-run" }, KEY);
      await runJevDryRun(
        ctx.db,
        { title: "样例 A" },
        { callSystemOne: answering(() => ({ type: "choice", choice: "matched" })) as never },
      );
      await runJevDryRun(
        ctx.db,
        { title: "样例 B" },
        { callSystemOne: answering(() => ({ type: "choice", choice: "not_matched" })) as never },
      );
      expect(listEvaluationsByBulletin(ctx.db, "any")).toEqual([]);
      expect(
        (ctx.db.prepare("SELECT COUNT(*) c FROM bulletins").get() as { c: number }).c,
      ).toBe(0);
    } finally {
      ctx.close();
    }
  });
});
