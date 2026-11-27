import { describe, expect, it, vi } from "vitest";
import { RULE_VERSION } from "@/lib/domain/constants";
import { setSecret } from "@/lib/db/repos/settings";
import { enqueueJob } from "@/lib/db/repos/jobs";
import { getBulletinAnalysis } from "@/lib/db/repos/analyses";
import { getBulletin } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { getNotificationByBulletin } from "@/lib/db/repos/notifications";
import { listDeliveriesByBulletin } from "@/lib/db/repos/deliveries";
import { loadEnv } from "@/lib/env";
import { createNotificationAndDeliveries, getNotificationPayload } from "@/lib/notify/dispatch";
import { saveNotifyConfig } from "@/lib/service/config";
import {
  STAGE2_LLM_SECRET_NAMESPACE,
  updateStage2Config,
} from "@/lib/service/stage2-config";
import { cleanupExpiredBulletins } from "@/lib/service/storage";
import { runAnalyzerOnce, STAGE2_FALLBACK_NOTE } from "@/lib/worker/analyzer";
import { runDelivererOnce } from "@/lib/worker/deliverer";
import { LEGACY_STAGE2_ANSWER, STAGE2_RATINGS } from "../fixtures/stage2";
import { createTestDb, testKey } from "../helpers/db";

function seedMatchedBulletin(
  ctx: ReturnType<typeof createTestDb>,
  bulletinId: string,
  createdAt = new Date().toISOString(),
) {
  ctx.db
    .prepare(
      `INSERT INTO bulletins
        (id, source, source_ns, source_id, url, title, content, category, price, brand, mall, published_at, payload, content_version, baseline, created_at)
       VALUES (?, 'xianbao', 'feed:test', ?, ?, '维达抽纸 24 包 29.9元', '券后好价', NULL, 29.9, '维达', '京东', ?, '{}', 'v1', 0, ?)`,
    )
    .run(bulletinId, bulletinId, `https://example.com/${bulletinId}`, createdAt, createdAt);

  ctx.db
    .prepare(
      `INSERT INTO need_groups (id, name, enabled, order_num, created_at, updated_at)
       VALUES ('g1', '日百', 1, 1, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(createdAt, createdAt);

  ctx.db
    .prepare(
      `INSERT INTO needs (id, group_id, name, note, enabled, version, created_at, updated_at)
       VALUES ('n1', 'g1', '抽纸', '单包不超过1.5元', 1, 1, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(createdAt, createdAt);

  ctx.db
    .prepare(
      `INSERT INTO evaluations
        (id, bulletin_id, need_id, need_name, need_note, need_version, config_version, rule_version,
         result, created_at, updated_at)
       VALUES (?, ?, 'n1', '抽纸', '单包不超过1.5元', 1, 1, ?, 'matched', ?, ?)`,
    )
    .run(`eval-${bulletinId}`, bulletinId, RULE_VERSION, createdAt, createdAt);
}

async function deliverFeishu(ctx: ReturnType<typeof createTestDb>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: 0 }));
  await expect(runDelivererOnce(ctx.db, loadEnv(), { fetchImpl }))
    .resolves.toMatchObject({ processed: 1, succeeded: 1 });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "https://feishu.example.com/webhook",
    expect.objectContaining({ method: "POST" }),
  );
  const body = fetchImpl.mock.calls[0][1]?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(String(body));
}

describe("worker/stage2-pipeline (AC8)", () => {
  it("recommended 将二级简报投递到飞书；rejected 拦截不推送", async () => {
    const ctx = createTestDb();
    const key = testKey();
    try {
      updateStage2Config(ctx.db, { enabled: true }, key);
      setSecret(ctx.db, STAGE2_LLM_SECRET_NAMESPACE, "sk-stage2", key);
      saveNotifyConfig(ctx.db, {
        feishu: { enabled: true, webhook: "https://feishu.example.com/webhook" },
      }, key);

      seedMatchedBulletin(ctx, "b-rec");
      enqueueJob(ctx.db, {
        kind: "analyze",
        payloadKey: "analyze:b-rec",
        payload: { bulletinId: "b-rec", triggerSource: "matched", needIds: ["n1"] },
        maxAttempts: 3,
      });

      await runAnalyzerOnce(ctx.db, undefined, {
        encryptionKey: key,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdict: "recommended",
                      ratings: STAGE2_RATINGS,
                      summary: "好价可入",
                      productName: "维达抽纸 24 包",
                      actualTotalPrice: 29.9,
                      unitPrice: 1.25,
                      unitLabel: "元/包",
                      priceFormula: "29.9 / 24 = 1.25",
                      orderSteps: ["直接下单"],
                      priceComparison: {
                        status: "no_data",
                        referencePrice: null,
                        source: null,
                        conclusion: "无数据",
                      },
                      requirementChecks: [
                        { needName: "抽纸", satisfied: true, reason: "满足" },
                      ],
                      risks: [],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      });

      const analysisRec = getBulletinAnalysis(ctx.db, "b-rec");
      expect(analysisRec?.verdict).toBe("recommended");
      expect(analysisRec?.answer?.ratings).toEqual(STAGE2_RATINGS);
      expect(getNotificationPayload(ctx.db, "b-rec")?.analysis?.ratings).toEqual(STAGE2_RATINGS);
      const feishuBody = await deliverFeishu(ctx);
      expect(feishuBody).toMatchObject({
        msg_type: "interactive",
        card: {
          header: { template: "green", title: { content: "[推荐] ★★★★☆ 维达抽纸 24 包" } },
          elements: expect.arrayContaining([
            expect.objectContaining({ text: { tag: "plain_text", content: "好价可入" } }),
          ]),
        },
      });
      expect(JSON.stringify(feishuBody)).not.toContain("29.9 / 24 = 1.25");

      // rejected 拦截不发送通知
      seedMatchedBulletin(ctx, "b-rej");
      enqueueJob(ctx.db, {
        kind: "analyze",
        payloadKey: "analyze:b-rej",
        payload: { bulletinId: "b-rej", triggerSource: "matched", needIds: ["n1"] },
        maxAttempts: 3,
      });

      await runAnalyzerOnce(ctx.db, undefined, {
        encryptionKey: key,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdict: "rejected",
                      ratings: { overall: 1, priceValue: 1, needMatch: 1, orderEase: null, lowRisk: null },
                      summary: "伪优惠",
                      productName: "维达抽纸",
                      actualTotalPrice: 50,
                      unitPrice: 2.1,
                      unitLabel: "元/包",
                      priceFormula: "50 / 24",
                      orderSteps: [],
                      priceComparison: {
                        status: "expensive",
                        referencePrice: 30,
                        source: "本地历史",
                        conclusion: "高于历史价",
                      },
                      requirementChecks: [
                        { needName: "抽纸", satisfied: false, reason: "超预算" },
                      ],
                      risks: ["高于预算"],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      });

      expect(getBulletinAnalysis(ctx.db, "b-rej")?.verdict).toBe("rejected");
      expect(getNotificationByBulletin(ctx.db, "b-rej")).toBeNull();
      expect(listDeliveriesByBulletin(ctx.db, "b-rej")).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });

  it("重试耗尽置 dead 后按 fallbackToStage1Notify 降级推送一级模板", async () => {
    const ctx = createTestDb();
    const key = testKey();
    try {
      updateStage2Config(
        ctx.db,
        { enabled: true, fallbackToStage1Notify: true },
        key,
      );
      setSecret(ctx.db, STAGE2_LLM_SECRET_NAMESPACE, "sk-stage2", key);
      saveNotifyConfig(ctx.db, {
        feishu: { enabled: true, webhook: "https://feishu.example.com/webhook" },
      }, key);
      seedMatchedBulletin(ctx, "b-dead");
      enqueueJob(ctx.db, {
        kind: "analyze",
        payloadKey: "analyze:b-dead",
        payload: { bulletinId: "b-dead", triggerSource: "matched", needIds: ["n1"] },
        maxAttempts: 1,
      });

      await runAnalyzerOnce(ctx.db, undefined, {
        encryptionKey: key,
        fetchImpl: async () => new Response("upstream down", { status: 503 }),
      });

      const analysis = getBulletinAnalysis(ctx.db, "b-dead");
      expect(analysis?.status).toBe("failed");
      expect(analysis?.fallbackNotified).toBe(true);
      const notif = getNotificationByBulletin(ctx.db, "b-dead");
      expect(notif).not.toBeNull();
      expect(notif?.payload).toContain(STAGE2_FALLBACK_NOTE);
      const feishuBody = await deliverFeishu(ctx);
      expect(feishuBody.msg_type).toBe("post");
      const feishuPost = feishuBody.content.post.zh_cn;
      expect(feishuPost.title).toContain("命中需求：抽纸");
      expect(feishuPost.content[0][0].text).toContain(STAGE2_FALLBACK_NOTE);
    } finally {
      ctx.close();
    }
  });

  it("从数据库读取缺少评分的历史通知快照并投递卡片（AC3）", async () => {
    const ctx = createTestDb();
    const key = testKey();
    try {
      saveNotifyConfig(ctx.db, {
        feishu: { enabled: true, webhook: "https://feishu.example.com/webhook" },
      }, key);
      seedMatchedBulletin(ctx, "b-legacy");
      const bulletin = getBulletin(ctx.db, "b-legacy");
      if (!bulletin) throw new Error("测试线报未写入数据库");
      createNotificationAndDeliveries(
        ctx.db, bulletin, listEvaluationsByBulletin(ctx.db, bulletin.id), key,
        { analysis: LEGACY_STAGE2_ANSWER },
      );

      const body = await deliverFeishu(ctx);
      expect(body.msg_type).toBe("interactive");
      expect(body.card.header.title.content).toBe("[推荐] 维达抽纸 24 包");
      expect(JSON.stringify(body.card.elements)).not.toMatch(/fields|[★☆]/u);
    } finally {
      ctx.close();
    }
  });

  it("存储清理保护在途 analyze 任务，并级联清理已过期核验记录", () => {
    const ctx = createTestDb();
    try {
      const oldIso = "2020-01-01T00:00:00.000Z";
      seedMatchedBulletin(ctx, "b-inflight", oldIso);
      enqueueJob(ctx.db, {
        kind: "analyze",
        payloadKey: "analyze:b-inflight",
        payload: { bulletinId: "b-inflight" },
      });

      seedMatchedBulletin(ctx, "b-expired", oldIso);
      ctx.db
        .prepare(
          `INSERT INTO bulletin_analyses
            (id, bulletin_id, trigger_source, status, verdict, model, base_url,
             active_tool_ids_json, steps_used, tool_calls_count, duration_ms,
             tool_trace_json, fallback_notified, created_at, updated_at)
           VALUES ('a1', 'b-expired', 'matched', 'succeeded', 'recommended', 'm', 'u',
                   '[]', 1, 0, 10, '[]', 0, ?, ?)`,
        )
        .run(oldIso, oldIso);

      const res = cleanupExpiredBulletins(ctx.db, { retentionDays: 30 });
      expect(res.cleanedBulletins).toBe(1);
      expect(res.cleanedAnalyses).toBe(1);
      expect(getBulletinAnalysis(ctx.db, "b-expired")).toBeNull();
      // 在途 analyze 任务对应的线报未被清理
      const stillThere = ctx.db
        .prepare("SELECT id FROM bulletins WHERE id = 'b-inflight'")
        .get();
      expect(stillThere).toBeDefined();
    } finally {
      ctx.close();
    }
  });
});
