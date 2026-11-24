import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { migrate } from "@/lib/db/migrate";
import { migrations } from "@/lib/db/migrations";
import { getBulletin, insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import {
  completeJevRequest,
  insertInFlightRequest,
} from "@/lib/db/repos/jev-requests";
import {
  completeStage2Request,
  getStage2Request,
  insertInFlightStage2Request,
  reclaimExpiredStage2RequestReservations,
} from "@/lib/db/repos/stage2-requests";
import { addJevKey } from "@/lib/service/jev-keys";
import { getJevUsageView } from "@/lib/service/jev-usage";
import { syncOpenRouterCatalog } from "@/lib/service/openrouter-pricing";
import { updateStage2Config } from "@/lib/service/stage2-config";
import {
  callStage2LlmWithLedger,
  STAGE2_REQUEST_LEASE_BUFFER_MS,
} from "@/lib/service/stage2-requests";
import { analyzeBulletinOnce } from "@/lib/worker/analyzer";

const KEY = testKey();

const VALID_STAGE2_JSON = JSON.stringify({
  verdict: "recommended",
  summary: "好价推荐",
  productName: "维达抽纸 24包",
  actualTotalPrice: 29.9,
  unitPrice: 1.25,
  unitLabel: "元/包",
  priceFormula: "29.9 / 24 = 1.25",
  orderSteps: ["直接下单"],
  priceComparison: {
    status: "no_data",
    referencePrice: null,
    source: null,
    conclusion: "无历史比价数据",
  },
  requirementChecks: [{ needName: "抽纸", satisfied: true, reason: "符合" }],
  risks: [],
});

describe("V12 二级调用账本、脱敏与跨级用量投影", () => {
  it("临时 SQLite 从 V11 增量升级到 V12，创建索引且重复迁移幂等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-v12-"));
    const dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    try {
      migrate(
        db,
        migrations.filter((m) => m.version <= 11),
      );
      expect(migrate(db).applied).toEqual([12]);
      expect(migrate(db).applied).toEqual([]);

      const indexes = db
        .prepare("PRAGMA index_list(stage2_requests)")
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain(
        "stage2_requests_started_id_idx",
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重复结算幂等、历史快照不受后续改价影响、过期预留回收为 interrupted 并允许迟到结果补写一次", () => {
    const ctx = createTestDb();
    try {
      const t0 = new Date("2026-11-24T01:00:00.000Z");
      const req = insertInFlightStage2Request(ctx.db, {
        purpose: "analyze",
        bulletinId: "b1",
        jobId: "j1",
        providerOrigin: "https://openrouter.ai",
        configVersion: 1,
        requestedModel: "openai/gpt-4o-mini",
        startedAt: t0,
        leaseUntil: new Date(t0.getTime() + 25_000 + STAGE2_REQUEST_LEASE_BUFFER_MS),
      });

      // 超过租约时间后被周期任务回收为 interrupted
      const reclaimed = reclaimExpiredStage2RequestReservations(
        ctx.db,
        new Date(t0.getTime() + 60_000),
      );
      expect(reclaimed).toBe(1);
      const interrupted = getStage2Request(ctx.db, req.id)!;
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.resultRecordedAt).toBeNull();
      expect(interrupted.costStatus).toBe("unknown");

      // 迟到真实结果可补写一次
      const firstSettle = completeStage2Request(ctx.db, {
        id: req.id,
        status: "succeeded",
        now: new Date(t0.getTime() + 65_000),
        responseModel: "openai/gpt-4o-mini",
        httpStatus: 200,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        pricingContext: {
          manualInputUsdPerMillion: null,
          manualOutputUsdPerMillion: null,
          openRouterModelId: null,
          catalog: {
            models: {
              "openai/gpt-4o-mini": {
                inputUsdPerMillion: 0.15,
                outputUsdPerMillion: 0.6,
              },
            },
            snapshotVersion: "openrouter-v1",
          },
        },
      });
      expect(firstSettle.recorded).toBe(true);
      // 1M * $0.15 + 0.5M * $0.60 = $0.45 = 450_000_000 nanos
      expect(firstSettle.request?.estimatedUsdNanos).toBe(450_000_000);
      expect(firstSettle.request?.inputRateUsdPerMillion).toBe(0.15);
      expect(firstSettle.request?.outputRateUsdPerMillion).toBe(0.6);

      // 重复结算幂等：使用不同费率重试不会覆盖历史金额
      const duplicateSettle = completeStage2Request(ctx.db, {
        id: req.id,
        status: "succeeded",
        now: new Date(t0.getTime() + 70_000),
        responseModel: "openai/gpt-4o-mini",
        httpStatus: 200,
        inputTokens: 9_999_999,
        outputTokens: 9_999_999,
        pricingContext: {
          manualInputUsdPerMillion: 99,
          manualOutputUsdPerMillion: 99,
          openRouterModelId: null,
          catalog: null,
        },
      });
      expect(duplicateSettle.recorded).toBe(false);
      expect(getStage2Request(ctx.db, req.id)?.estimatedUsdNanos).toBe(
        450_000_000,
      );
    } finally {
      ctx.close();
    }
  });

  it("失败响应脱敏（不落库上游原始正文/凭据）且在校验内容前保留安全模型与 Token 元数据", async () => {
    const ctx = createTestDb();
    try {
      const t0 = new Date("2026-11-24T02:00:00.000Z");

      // 场景 1：HTTP 200 但缺少 choices[0].message（结构异常），但携带 model 与 usage
      await expect(
        callStage2LlmWithLedger(ctx.db, {
          purpose: "test",
          configVersion: 1,
          manualInputUsdPerMillion: 1,
          manualOutputUsdPerMillion: 2,
          openRouterModelId: null,
          now: () => t0,
          request: {
            baseUrl: "https://user:secret-pass@gateway.example.com/v1?api_key=leak",
            apiKey: "sk-top-secret",
            model: "req-model",
            timeoutMs: 10_000,
            temperature: 0,
            messages: [{ role: "user", content: "hi" }],
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  model: "resp-model-v2",
                  usage: { prompt_tokens: 1000, completion_tokens: 500 },
                  error_detail: "RAW_SECRET_LEAK_SHOULD_NOT_BE_STORED",
                }),
                { status: 200 },
              ),
          },
        }),
      ).rejects.toThrow();

      // 场景 2：HTTP 500 含上游敏感正文
      await expect(
        callStage2LlmWithLedger(ctx.db, {
          purpose: "test",
          configVersion: 1,
          manualInputUsdPerMillion: 1,
          manualOutputUsdPerMillion: 2,
          openRouterModelId: null,
          now: () => new Date(t0.getTime() + 1_000),
          request: {
            baseUrl: "https://gateway.example.com/v1",
            apiKey: "sk-top-secret",
            model: "req-model",
            timeoutMs: 10_000,
            temperature: 0,
            messages: [{ role: "user", content: "hi" }],
            fetchImpl: async () =>
              new Response("INTERNAL_UPSTREAM_BODY_SECRET_TOKEN_XYZ", {
                status: 500,
              }),
          },
        }),
      ).rejects.toThrow();

      const usage = getJevUsageView(ctx.db, { stage: "stage2", limit: 10, offset: 0 });
      expect(usage.recent.total).toBe(2);

      const err500 = usage.recent.items[0];
      expect(err500.status).toBe("failed");
      expect(err500.httpStatus).toBe(500);
      expect(err500.errorMessage).toBe("二级模型服务端错误");
      expect(err500.errorMessage).not.toContain("INTERNAL_UPSTREAM_BODY_SECRET_TOKEN_XYZ");

      const invalidStruct = usage.recent.items[1];
      expect(invalidStruct.status).toBe("failed");
      expect(invalidStruct.errorMessage).toBe("二级模型返回结构异常");
      expect(invalidStruct.providerOrigin).toBe("https://gateway.example.com");
      expect(invalidStruct.responseModel).toBe("resp-model-v2");
      expect(invalidStruct.inputTokens).toBe(1000);
      expect(invalidStruct.outputTokens).toBe(500);
      // 1000 * $1/M + 500 * $2/M = $0.002 = 2_000_000 nanos
      expect(invalidStruct.costStatus).toBe("known");
      expect(invalidStruct.estimatedUsdNanos).toBe(2_000_000);
    } finally {
      ctx.close();
    }
  });

  it("多轮核验（格式修正/失败轮次）逐轮入账，后续失败仍保留前轮用量", async () => {
    const ctx = createTestDb();
    try {
      await syncOpenRouterCatalog(ctx.db, {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "openai/gpt-4o-mini",
                  pricing: { prompt: "0.00000015", completion: "0.0000006" },
                },
              ],
            }),
            { status: 200 },
          ),
      });

      updateStage2Config(
        ctx.db,
        {
          enabled: true,
          llm: {
            baseUrl: "https://openrouter.ai/api/v1",
            model: "openai/gpt-4o-mini",
          },
          apiKey: "sk-or-test",
        },
        KEY,
      );

      const inserted = insertBulletinIfAbsent(ctx.db, makeNormalized(), {
        baseline: false,
      });
      const bulletin = getBulletin(ctx.db, inserted.id)!;

      // 第 1 轮返回非 JSON（触发格式修正），第 2 轮返回合法 JSON
      let round = 0;
      const twoRoundFetch: typeof fetch = async () => {
        round += 1;
        if (round === 1) {
          return new Response(
            JSON.stringify({
              model: "openai/gpt-4o-mini",
              choices: [{ message: { content: "not-json" } }],
              usage: { prompt_tokens: 1000, completion_tokens: 200 },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            model: "openai/gpt-4o-mini",
            choices: [{ message: { content: VALID_STAGE2_JSON } }],
            usage: { prompt_tokens: 1500, completion_tokens: 300 },
          }),
          { status: 200 },
        );
      };

      const analysis = await analyzeBulletinOnce(ctx.db, bulletin, {
        triggerSource: "manual",
        encryptionKey: KEY,
        fetchImpl: twoRoundFetch,
      });
      expect(analysis.status).toBe("succeeded");

      // 再跑一次：第 1 轮成功但格式非法，第 2 轮修正请求返回 500 失败 -> 两轮均入账且第 1 轮用量保留
      let failRound = 0;
      await expect(
        analyzeBulletinOnce(ctx.db, bulletin, {
          triggerSource: "manual",
          encryptionKey: KEY,
          fetchImpl: async () => {
            failRound += 1;
            if (failRound === 1) {
              return new Response(
                JSON.stringify({
                  model: "openai/gpt-4o-mini",
                  choices: [{ message: { content: "bad-json" } }],
                  usage: { prompt_tokens: 500, completion_tokens: 100 },
                }),
                { status: 200 },
              );
            }
            return new Response("upstream down", { status: 500 });
          },
        }),
      ).rejects.toThrow();

      const view = getJevUsageView(ctx.db, { stage: "stage2", limit: 20, offset: 0 });
      expect(view.recent.total).toBe(4);
      expect(view.summary.failedCount).toBe(1);
      expect(view.summary.knownRequestCount).toBe(3);
      expect(view.summary.unknownCostCount).toBe(1);
      expect(view.summary.inputTokensKnown).toBe(1000 + 1500 + 500);
      expect(view.summary.outputTokensKnown).toBe(200 + 300 + 100);
    } finally {
      ctx.close();
    }
  });

  it("跨级统计：省略 stage 兼容 stage1、all/stage2 忽略渠道、COALESCE 模型汇总与筛选总数一致、跨级稳定分页", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "一级主密钥", apiKey: "sk-1" }, KEY);
      const t1 = new Date("2026-11-24T03:00:00.000Z");
      const t2 = new Date("2026-11-24T03:01:00.000Z");

      // 插入一条一级请求（t1，id = "shared-id"，requested = "jev-latest", response = "jev-1.13.0"）
      const s1Id = insertInFlightRequest(ctx.db, {
        id: "shared-id",
        channelId: "channel-typesafe",
        baseUrl: "https://api.typesafe.ai",
        keyId: key.id,
        keyLabel: key.label,
        keyGeneration: key.generation,
        purpose: "evaluate",
        requestedModel: "jev-latest",
        providerOrigin: "https://api.typesafe.ai",
        configVersion: 1,
        startedAt: t1,
        leaseUntil: new Date(t1.getTime() + 60_000),
      }).id;
      completeJevRequest(ctx.db, {
        id: s1Id,
        status: "succeeded",
        now: t1,
        responseModel: "jev-1.13.0",
        inputTokens: 1_000_000,
      });

      // 插入一条二级请求，与一级拥有完全相同的 started_at 和 id（测试稳定排序 stage DESC）
      const s2SameId = insertInFlightStage2Request(ctx.db, {
        id: "shared-id",
        purpose: "analyze",
        providerOrigin: "https://openrouter.ai",
        configVersion: 1,
        requestedModel: "openai/gpt-4o-mini",
        startedAt: t1,
        leaseUntil: new Date(t1.getTime() + 60_000),
      }).id;
      completeStage2Request(ctx.db, {
        id: s2SameId,
        status: "succeeded",
        now: t1,
        responseModel: "openai/gpt-4o-mini",
        httpStatus: 200,
        inputTokens: 1_000_000,
        outputTokens: 0,
        pricingContext: {
          manualInputUsdPerMillion: 0,
          manualOutputUsdPerMillion: 0,
          openRouterModelId: null,
          catalog: null,
        },
      });

      // 再插入一条二级请求（t2，responseModel 为 null，回落到 requestedModel）
      const s2LatestId = insertInFlightStage2Request(ctx.db, {
        id: "s2-latest",
        purpose: "test",
        providerOrigin: "https://gateway.example.com",
        configVersion: 1,
        requestedModel: "custom-model",
        startedAt: t2,
        leaseUntil: new Date(t2.getTime() + 60_000),
      }).id;
      completeStage2Request(ctx.db, {
        id: s2LatestId,
        status: "succeeded",
        now: t2,
        responseModel: null,
        httpStatus: 200,
        inputTokens: 100,
        outputTokens: 50,
        pricingContext: {
          manualInputUsdPerMillion: null,
          manualOutputUsdPerMillion: null,
          openRouterModelId: null,
          catalog: null,
        },
      });

      // 1. 省略 stage 兼容 stage1
      const defaultView = getJevUsageView(ctx.db);
      expect(defaultView.stage).toBe("stage1");
      expect(defaultView.recent.total).toBe(1);
      expect(defaultView.byKey).toHaveLength(1);

      // 2. all 视图忽略不存在的 channelId，合并全部 3 条，并按 (started_at DESC, id DESC, stage DESC) 稳定分页
      const allPage1 = getJevUsageView(ctx.db, {
        stage: "all",
        channelId: "non-existent-channel",
        limit: 2,
        offset: 0,
      });
      const allPage2 = getJevUsageView(ctx.db, {
        stage: "all",
        channelId: "non-existent-channel",
        limit: 2,
        offset: 2,
      });
      expect(allPage1.summary.totalRequests).toBe(3);
      expect(allPage1.recent.total).toBe(3);
      expect(allPage1.byKey).toHaveLength(0);
      expect(allPage1.stage2StatsStartedAt).toBe(t1.toISOString());

      const mergedIds = [...allPage1.recent.items, ...allPage2.recent.items].map(
        (item) => `${item.stage}:${item.id}`,
      );
      expect(mergedIds).toEqual([
        "stage2:s2-latest",
        "stage2:shared-id",
        "stage1:shared-id",
      ]);

      // 区分免费 $0.00 与 费用未知 null
      const freeRow = allPage1.recent.items[1];
      expect(freeRow.costStatus).toBe("known");
      expect(freeRow.estimatedUsd).toBe("0.00");
      const unknownRow = allPage1.recent.items[0];
      expect(unknownRow.costStatus).toBe("unknown");
      expect(unknownRow.estimatedUsd).toBeNull();

      // 3. 按 COALESCE(response_model, requested_model) 汇总与过滤总数一致
      expect(allPage1.byModel.reduce((s, r) => s + r.requestCount, 0)).toBe(3);
      expect(allPage1.availableModels).toEqual([
        "custom-model",
        "jev-1.13.0",
        "openai/gpt-4o-mini",
      ]);

      const byEffectiveModel = getJevUsageView(ctx.db, {
        stage: "all",
        model: "jev-1.13.0",
      });
      expect(byEffectiveModel.summary.totalRequests).toBe(1);
      expect(byEffectiveModel.recent.total).toBe(1);
      expect(byEffectiveModel.byModel).toHaveLength(1);
      expect(byEffectiveModel.byModel[0].model).toBe("jev-1.13.0");
      // availableModels 不因当前 model 过滤而丢失其他可选模型
      expect(byEffectiveModel.availableModels).toHaveLength(3);
    } finally {
      ctx.close();
    }
  });
});
