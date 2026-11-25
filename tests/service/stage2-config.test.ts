import { describe, expect, it } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { setSetting } from "@/lib/db/repos/settings";
import {
  getStage2Config,
  resolveStage2DraftTestPricing,
  STAGE2_SETTING_NAMESPACE,
  updateStage2Config,
} from "@/lib/service/stage2-config";

const KEY = testKey();

it("未配置二级模型超时时默认 180 秒，已保存的值优先", () => {
  const ctx = createTestDb();
  try {
    expect(getStage2Config(ctx.db, KEY).config.llm.timeoutMs).toBe(180_000);
    setSetting(ctx.db, STAGE2_SETTING_NAMESPACE, { llm: { model: "gpt-4o" } });
    expect(getStage2Config(ctx.db, KEY).config.llm.timeoutMs).toBe(180_000);
    updateStage2Config(ctx.db, { llm: { timeoutMs: 25_000 } }, KEY);
    expect(getStage2Config(ctx.db, KEY).config.llm.timeoutMs).toBe(25_000);
  } finally {
    ctx.close();
  }
});

describe("二级配置费率补丁、模型切换与草稿测试契约", () => {
  it("历史配置缺省费率与参考模型读出 null，同模型补丁沿用未传字段、null 清除、0 保留", () => {
    const ctx = createTestDb();
    try {
      // 模拟 V11 旧配置（无定价字段）
      setSetting(ctx.db, STAGE2_SETTING_NAMESPACE, {
        enabled: true,
        includeUncertain: false,
        notifyOnInsufficientInfo: false,
        fallbackToStage1Notify: true,
        concurrency: 1,
        llm: {
          baseUrl: "https://gateway.example.com/v1",
          model: "gpt-4o-mini",
          timeoutMs: 25000,
          maxSteps: 5,
          temperature: 0.1,
        },
      });

      const legacy = getStage2Config(ctx.db, KEY);
      expect(legacy.config.llm.inputUsdPerMillion).toBeNull();
      expect(legacy.config.llm.outputUsdPerMillion).toBeNull();
      expect(legacy.config.llm.openRouterModelId).toBeNull();

      // 保存手动费率与参考模型 ID（含真实 0）
      const s1 = updateStage2Config(
        ctx.db,
        {
          llm: {
            inputUsdPerMillion: 0,
            outputUsdPerMillion: 0.6,
            openRouterModelId: "openai/gpt-4o-mini",
          },
          expectedVersion: legacy.version,
        },
        KEY,
      );
      expect(s1.config.llm.inputUsdPerMillion).toBe(0);
      expect(s1.config.llm.outputUsdPerMillion).toBe(0.6);
      expect(s1.config.llm.openRouterModelId).toBe("openai/gpt-4o-mini");

      // 同模型/端点下仅改 temperature，未传费率字段保持不变
      const s2 = updateStage2Config(
        ctx.db,
        {
          llm: { temperature: 0.2 },
          expectedVersion: s1.version,
        },
        KEY,
      );
      expect(s2.config.llm.inputUsdPerMillion).toBe(0);
      expect(s2.config.llm.outputUsdPerMillion).toBe(0.6);
      expect(s2.config.llm.openRouterModelId).toBe("openai/gpt-4o-mini");

      // 显式传 null 清除
      const s3 = updateStage2Config(
        ctx.db,
        {
          llm: { outputUsdPerMillion: null },
          expectedVersion: s2.version,
        },
        KEY,
      );
      expect(s3.config.llm.inputUsdPerMillion).toBe(0);
      expect(s3.config.llm.outputUsdPerMillion).toBeNull();

      // 并发编辑版本号冲突抛 409
      expect(() =>
        updateStage2Config(
          ctx.db,
          { enabled: false, expectedVersion: s1.version },
          KEY,
        ),
      ).toThrow(/已被其他操作更新/);
    } finally {
      ctx.close();
    }
  });

  it("切换模型或端点时重置未传价格与参考 ID；直连 OpenRouter 忽略并清空参考 ID", () => {
    const ctx = createTestDb();
    try {
      const s1 = updateStage2Config(
        ctx.db,
        {
          llm: {
            baseUrl: "https://gateway.example.com/v1",
            model: "model-a",
            inputUsdPerMillion: 1.5,
            outputUsdPerMillion: 3.0,
            openRouterModelId: "openai/gpt-4o",
          },
        },
        KEY,
      );

      // 仅改 model 且未传费率：旧费率与参考 ID 必须重置为 null
      const s2 = updateStage2Config(
        ctx.db,
        {
          llm: { model: "model-b" },
          expectedVersion: s1.version,
        },
        KEY,
      );
      expect(s2.config.llm.inputUsdPerMillion).toBeNull();
      expect(s2.config.llm.outputUsdPerMillion).toBeNull();
      expect(s2.config.llm.openRouterModelId).toBeNull();

      // 切换端点为直连 HTTPS OpenRouter 时，即便传入 openRouterModelId 也强制清空
      const s3 = updateStage2Config(
        ctx.db,
        {
          llm: {
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/gpt-4o-mini",
            inputUsdPerMillion: 0.25,
            openRouterModelId: "should-be-ignored",
          },
          expectedVersion: s2.version,
        },
        KEY,
      );
      expect(s3.config.llm.inputUsdPerMillion).toBe(0.25);
      expect(s3.config.llm.outputUsdPerMillion).toBeNull();
      expect(s3.config.llm.openRouterModelId).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("草稿连接测试在模型或端点变化时绝不继承旧模型的已保存手动费率", () => {
    const saved = {
      baseUrl: "https://gateway.example.com/v1",
      model: "model-a",
      timeoutMs: 25_000,
      maxSteps: 5,
      temperature: 0.1,
      inputUsdPerMillion: 2.0,
      outputUsdPerMillion: 8.0,
      openRouterModelId: "openai/gpt-4o",
    };

    // 同模型同端点未传价格 -> 继承已保存配置
    expect(
      resolveStage2DraftTestPricing(saved, {
        baseUrl: saved.baseUrl,
        model: saved.model,
      }),
    ).toEqual({
      inputUsdPerMillion: 2.0,
      outputUsdPerMillion: 8.0,
      openRouterModelId: "openai/gpt-4o",
    });

    // 模型变更且未传价格 -> 绝不继承旧手动费率与参考 ID
    expect(
      resolveStage2DraftTestPricing(saved, {
        baseUrl: saved.baseUrl,
        model: "model-b",
      }),
    ).toEqual({
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      openRouterModelId: null,
    });

    // 端点变更且显式传入新草稿价格 -> 使用草稿价格；直连 OpenRouter 忽略参考 ID
    expect(
      resolveStage2DraftTestPricing(saved, {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
        inputUsdPerMillion: 0.1,
        openRouterModelId: "ignored/ref",
      }),
    ).toEqual({
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: null,
      openRouterModelId: null,
    });
  });
});
