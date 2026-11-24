import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { formatUsdFromNanos } from "@/lib/jev/pricing";
import {
  decodeOpenRouterModelsPayload,
  estimateStage2Cost,
  isDirectOpenRouterBaseUrl,
  resolveStage2Rates,
} from "@/lib/stage2/pricing";
import {
  getOpenRouterCatalogState,
  OPENROUTER_CATALOG_NAMESPACE,
  OPENROUTER_REFRESH_FAILURE_TTL_MS,
  OPENROUTER_REFRESH_SUCCESS_TTL_MS,
  syncOpenRouterCatalog,
} from "@/lib/service/openrouter-pricing";
import { getStage2Config, STAGE2_SETTING_NAMESPACE } from "@/lib/service/stage2-config";
import { getSetting } from "@/lib/db/repos/settings";

/**
 * 二级定价纯函数与 OpenRouter 目录同步测试（注入式 fetchImpl，离线可重复；
 * 不代表对线上 OpenRouter 接口的实时验证）。
 */

describe("二级定价规则与 OpenRouter 精简目录解码", () => {
  it("严格校验直连 HTTPS OpenRouter 官方端点", () => {
    expect(isDirectOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isDirectOpenRouterBaseUrl("https://openrouter.ai:443/api/v1")).toBe(true);
    expect(isDirectOpenRouterBaseUrl("http://openrouter.ai/api/v1")).toBe(false);
    expect(isDirectOpenRouterBaseUrl("https://openrouter.ai:8443/api/v1")).toBe(false);
    expect(isDirectOpenRouterBaseUrl("https://openrouter.ai.example.com/api/v1")).toBe(false);
    expect(isDirectOpenRouterBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("精确匹配模型 ID（不剥离 :free / :online），解码有效非负价并丢弃负值/非法价", () => {
    const decoded = decodeOpenRouterModelsPayload({
      data: [
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o Mini",
          description: "should not be stored",
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        },
        {
          id: "google/gemini-2.0-flash-exp:free",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "openrouter/auto",
          pricing: { prompt: "-1", completion: "invalid" },
        },
      ],
    });

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.modelCount).toBe(3);
    expect(decoded.models["openai/gpt-4o-mini"]).toEqual({
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.6,
    });
    expect(decoded.models["google/gemini-2.0-flash-exp:free"]).toEqual({
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    });
    expect(decoded.models["openrouter/auto"]).toEqual({
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
    });

    const catalog = { models: decoded.models, snapshotVersion: "openrouter-v1" };

    // 精确匹配 :free 后缀；去掉后缀或换成 :online 不得模糊命中
    const freeExact = resolveStage2Rates({
      baseUrl: "https://openrouter.ai/api/v1",
      requestedModel: "google/gemini-2.0-flash-exp:free",
      manualInputUsdPerMillion: null,
      manualOutputUsdPerMillion: null,
      openRouterModelId: null,
      catalog,
    });
    expect(freeExact.inputUsdPerMillion).toBe(0);
    expect(freeExact.outputUsdPerMillion).toBe(0);
    expect(freeExact.inputSource).toBe("openrouter");
    expect(freeExact.matchedCatalogModelId).toBe("google/gemini-2.0-flash-exp:free");

    const suffixMismatch = resolveStage2Rates({
      baseUrl: "https://openrouter.ai/api/v1",
      requestedModel: "openai/gpt-4o-mini:online",
      manualInputUsdPerMillion: null,
      manualOutputUsdPerMillion: null,
      openRouterModelId: null,
      catalog,
    });
    expect(suffixMismatch.inputUsdPerMillion).toBeNull();
    expect(suffixMismatch.outputUsdPerMillion).toBeNull();
    expect(suffixMismatch.matchedCatalogModelId).toBeNull();
  });

  it("局部覆盖、真实零价覆盖目录、自定义端点仅用参考 ID", () => {
    const catalog = {
      models: {
        "openai/gpt-4o-mini": { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
      },
      snapshotVersion: "openrouter-v1",
    };

    // 手填输入价 + 目录输出价同时生效
    const partial = resolveStage2Rates({
      baseUrl: "https://openrouter.ai/api/v1",
      requestedModel: "openai/gpt-4o-mini",
      manualInputUsdPerMillion: 0.2,
      manualOutputUsdPerMillion: null,
      openRouterModelId: null,
      catalog,
    });
    expect(partial.inputUsdPerMillion).toBe(0.2);
    expect(partial.inputSource).toBe("manual");
    expect(partial.outputUsdPerMillion).toBe(0.6);
    expect(partial.outputSource).toBe("openrouter");

    // 手填 0 覆盖目录正价（真实免费）
    const zeroOverride = resolveStage2Rates({
      baseUrl: "https://openrouter.ai/api/v1",
      requestedModel: "openai/gpt-4o-mini",
      manualInputUsdPerMillion: 0,
      manualOutputUsdPerMillion: 0,
      openRouterModelId: null,
      catalog,
    });
    expect(zeroOverride.inputUsdPerMillion).toBe(0);
    expect(zeroOverride.inputSource).toBe("manual");
    expect(zeroOverride.outputUsdPerMillion).toBe(0);
    expect(zeroOverride.outputSource).toBe("manual");

    const zeroCost = estimateStage2Cost({
      inputTokens: 1000,
      outputTokens: 500,
      rates: zeroOverride,
    });
    expect(zeroCost.costStatus).toBe("known");
    expect(zeroCost.estimatedUsdNanos).toBe(0);
    expect(formatUsdFromNanos(zeroCost.estimatedUsdNanos!)).toBe("0.00");

    // 自定义端点不按 model 自动匹配，仅使用显式 openRouterModelId
    const customNoRef = resolveStage2Rates({
      baseUrl: "https://my-gateway.example.com/v1",
      requestedModel: "openai/gpt-4o-mini",
      manualInputUsdPerMillion: null,
      manualOutputUsdPerMillion: null,
      openRouterModelId: null,
      catalog,
    });
    expect(customNoRef.inputUsdPerMillion).toBeNull();
    expect(customNoRef.matchedCatalogModelId).toBeNull();

    const customWithRef = resolveStage2Rates({
      baseUrl: "https://my-gateway.example.com/v1",
      requestedModel: "my-alias",
      manualInputUsdPerMillion: null,
      manualOutputUsdPerMillion: null,
      openRouterModelId: "openai/gpt-4o-mini",
      catalog,
    });
    expect(customWithRef.inputUsdPerMillion).toBe(0.15);
    expect(customWithRef.outputUsdPerMillion).toBe(0.6);
    expect(customWithRef.matchedCatalogModelId).toBe("openai/gpt-4o-mini");
  });

  it("极小正费用最小 1 纳美元保护、安全整数溢出降级、无 Token 或缺正价方向保持未知", () => {
    const tinyRate = resolveStage2Rates({
      baseUrl: "https://api.openai.com/v1",
      requestedModel: "tiny",
      manualInputUsdPerMillion: 0.0001, // 1 token = 0.1 nano -> rounds to 0, must clamp to 1 nano
      manualOutputUsdPerMillion: 0,
      openRouterModelId: null,
      catalog: null,
    });

    const tinyCost = estimateStage2Cost({
      inputTokens: 1,
      outputTokens: 0,
      rates: tinyRate,
    });
    expect(tinyCost.costStatus).toBe("known");
    expect(tinyCost.estimatedUsdNanos).toBe(1);
    expect(formatUsdFromNanos(tinyCost.estimatedUsdNanos!)).toBe("0.000000001");

    // 溢出降级为未知
    const overflow = estimateStage2Cost({
      inputTokens: 9_000_000_000_000,
      outputTokens: 0,
      rates: {
        ...tinyRate,
        inputUsdPerMillion: 1_000_000,
      },
    });
    expect(overflow.costStatus).toBe("unknown");
    expect(overflow.estimatedUsdNanos).toBeNull();

    // 无任何可用 Token 时即便费率为 0 也保留未知
    const noTokens = estimateStage2Cost({
      inputTokens: null,
      outputTokens: null,
      rates: {
        ...tinyRate,
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      },
    });
    expect(noTokens.costStatus).toBe("unknown");
    expect(noTokens.estimatedUsdNanos).toBeNull();

    // 正价方向缺 Token 保持未知
    const missingOutputTok = estimateStage2Cost({
      inputTokens: 100,
      outputTokens: null,
      rates: {
        ...tinyRate,
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.6,
      },
    });
    expect(missingOutputTok.costStatus).toBe("unknown");
    expect(missingOutputTok.estimatedUsdNanos).toBeNull();
  });

  it("目录同步独立持久化、24h/1h TTL、断网/坏响应保留旧快照、跨进程占位锁防重叠", async () => {
    const ctx = createTestDb();
    try {
      let nowMs = Date.parse("2026-11-24T00:00:00.000Z");
      const now = () => new Date(nowMs);

      const goodFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-4o-mini",
                pricing: { prompt: "0.00000015", completion: "0.0000006" },
                extra_large_blob: "x".repeat(5000),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      const first = await syncOpenRouterCatalog(ctx.db, {
        fetchImpl: goodFetch,
        now,
      });
      expect(first.synced).toBe(true);
      expect(first.modelCount).toBe(1);

      // 独立 namespace 仅保存精简映射，不污染 stage2 业务配置
      const rawSetting = getSetting(ctx.db, OPENROUTER_CATALOG_NAMESPACE);
      expect(JSON.stringify(rawSetting?.value)).not.toContain("extra_large_blob");
      expect(getSetting(ctx.db, STAGE2_SETTING_NAMESPACE)).toBeNull();
      expect(getStage2Config(ctx.db).version).toBe(0);

      // 24h 内常规同步跳过
      nowMs += OPENROUTER_REFRESH_SUCCESS_TTL_MS - 1_000;
      const skippedFresh = await syncOpenRouterCatalog(ctx.db, {
        fetchImpl: goodFetch,
        now,
      });
      expect(skippedFresh.synced).toBe(false);
      expect(skippedFresh.skippedReason).toBe("fresh");

      // 超过 24h 后遇到坏响应：保留旧快照并记录错误
      nowMs += 2_000;
      const badFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 });
      const failedBad = await syncOpenRouterCatalog(ctx.db, {
        fetchImpl: badFetch,
        now,
      });
      expect(failedBad.synced).toBe(false);
      expect(failedBad.error).toMatch(/未包含任何有效模型/);

      const afterBad = getOpenRouterCatalogState(ctx.db);
      expect(afterBad.status).toBe("error");
      expect(afterBad.modelCount).toBe(1);
      expect(afterBad.models["openai/gpt-4o-mini"]).toEqual({
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.6,
      });
      expect(afterBad.lastSuccessAt).toBe("2026-11-24T00:00:00.000Z");

      // 失败后 1h 内常规同步退避跳过
      nowMs += OPENROUTER_REFRESH_FAILURE_TTL_MS - 1_000;
      const skippedBackoff = await syncOpenRouterCatalog(ctx.db, {
        fetchImpl: goodFetch,
        now,
      });
      expect(skippedBackoff.synced).toBe(false);
      expect(skippedBackoff.skippedReason).toBe("backoff");

      // 断网异常同样保留旧快照；手动 force 可立即触发
      const networkErrorFetch: typeof fetch = async () => {
        throw new TypeError("fetch failed");
      };
      const forcedFail = await syncOpenRouterCatalog(ctx.db, {
        force: true,
        fetchImpl: networkErrorFetch,
        now,
      });
      expect(forcedFail.synced).toBe(false);
      expect(forcedFail.error).toMatch(/无法连接/);
      expect(getOpenRouterCatalogState(ctx.db).modelCount).toBe(1);

      // 跨进程刷新占位锁：正在同步时第二个并发请求被跳过
      let releaseFetch!: () => void;
      const slowFetch: typeof fetch = () =>
        new Promise((resolve) => {
          releaseFetch = () =>
            resolve(
              new Response(
                JSON.stringify({
                  data: [
                    {
                      id: "openai/gpt-4o-mini",
                      pricing: { prompt: "0.0000002", completion: "0.0000008" },
                    },
                  ],
                }),
                { status: 200 },
              ),
            );
        });

      const p1 = syncOpenRouterCatalog(ctx.db, {
        force: true,
        fetchImpl: slowFetch,
        now,
      });
      const p2 = await syncOpenRouterCatalog(ctx.db, {
        force: true,
        fetchImpl: goodFetch,
        now,
      });
      expect(p2.synced).toBe(false);
      expect(p2.skippedReason).toBe("locked");

      releaseFetch();
      const r1 = await p1;
      expect(r1.synced).toBe(true);
      expect(getOpenRouterCatalogState(ctx.db).models["openai/gpt-4o-mini"]).toEqual({
        inputUsdPerMillion: 0.2,
        outputUsdPerMillion: 0.8,
      });
    } finally {
      ctx.close();
    }
  });
});
