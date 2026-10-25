import { describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import {
  listModelChannels,
  createModelChannel,
  updateModelChannel,
  setActiveModelChannel,
  deleteModelChannel,
} from "@/lib/db/repos/model-channels";
import { runJevDryRun } from "@/lib/service/dry-run";
import { listJevKeys, createJevKey } from "@/lib/db/repos/jev-keys";
import { setSecret } from "@/lib/db/repos/settings";

function answering(choiceFor: (questionId: string) => unknown) {
  return vi.fn(
    async (_config: unknown, request: { questions: Record<string, unknown> }) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, choiceFor(id)]),
      ),
    }),
  );
}

describe("多渠道服务管理与需求试判模拟需求", () => {
  it("数据库初始化后存在内置预设渠道且有且仅有一个活动渠道", () => {
    const ctx = createTestDb();
    try {
      const channels = listModelChannels(ctx.db);
      expect(channels.length).toBeGreaterThanOrEqual(3);
      const active = channels.filter((c) => c.isActive);
      expect(active).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("支持添加自定义渠道并切换为启用渠道", () => {
    const ctx = createTestDb();
    try {
      const custom = createModelChannel(ctx.db, {
        name: "测试中转渠道",
        baseUrl: "https://api.custom-proxy.com",
        model: "custom-model",
      });
      expect(custom.id).toBeDefined();
      expect(custom.isActive).toBe(false);

      const activated = setActiveModelChannel(ctx.db, custom.id);
      expect(activated?.isActive).toBe(true);

      const all = listModelChannels(ctx.db);
      const activeList = all.filter((c) => c.isActive);
      expect(activeList).toHaveLength(1);
      expect(activeList[0].id).toBe(custom.id);
    } finally {
      ctx.close();
    }
  });

  it("已启用的渠道禁止直接删除", () => {
    const ctx = createTestDb();
    try {
      const all = listModelChannels(ctx.db);
      const active = all.find((c) => c.isActive)!;
      const res = deleteModelChannel(ctx.db, active.id);
      expect(res.deleted).toBe(false);
      expect(res.reason).toContain("当前启用的渠道不能直接删除");
    } finally {
      ctx.close();
    }
  });

  it("API 密钥能够关联渠道与 baseUrl 并支持按渠道/baseUrl 查询", () => {
    const ctx = createTestDb();
    try {
      const ch = createModelChannel(ctx.db, {
        name: "专有渠道",
        baseUrl: "https://exclusive.api.com",
        model: "exclusive-model",
      });

      const key = createJevKey(ctx.db, {
        label: "专有 Key",
        secretNamespace: "exclusive.key.ns",
        channelId: ch.id,
        baseUrl: ch.baseUrl,
      });

      expect(key.channelId).toBe(ch.id);
      expect(key.baseUrl).toBe(ch.baseUrl);

      const channelKeys = listJevKeys(ctx.db, { channelId: ch.id });
      expect(channelKeys).toHaveLength(1);
      expect(channelKeys[0].id).toBe(key.id);

      const otherKeys = listJevKeys(ctx.db, { channelId: "non-existent" });
      expect(otherKeys).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("需求试判在系统无任何需求时，可传入 mockNeeds 进行试判", async () => {
    const ctx = createTestDb();
    try {
      // 库中没有任何需求
      // 传入 mock 需求调 dry run
      const mockCall = answering(() => ({
        type: "choice",
        choice: "matched",
        confidence: 0.95,
        probabilities: { matched: 0.9, not_matched: 0.05, uncertain: 0.05 },
      }));

      // 配置一个可用 Key
      const keyObj = createJevKey(ctx.db, {
        label: "Mock Key",
        secretNamespace: "mock.ns",
      });
      setSecret(ctx.db, "mock.ns", "test-secret-value", testKey());

      const result = await runJevDryRun(
        ctx.db,
        {
          title: "清风抽纸 3 层 100 抽 * 24 包",
          mockNeeds: [
            { name: "抽纸", note: "各种面巾纸、软抽，排除卷纸湿巾" },
          ],
        },
        { callSystemOne: mockCall as any },
      );

      expect(result.needsCount).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].needName).toBe("抽纸");
      expect(result.results[0].result).toBe("matched");
    } finally {
      ctx.close();
    }
  });
});
