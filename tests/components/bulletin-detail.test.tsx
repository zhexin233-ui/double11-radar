import { MantineProvider } from "@mantine/core";
import { useParams } from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BulletinDetailPage from "@/app/(admin)/bulletins/[id]/page";
import { GET as getBulletinDetail } from "@/app/api/bulletins/[id]/route";
import type { BulletinDetailDto } from "@/components/api-types";
import { useApiResource } from "@/components/use-api";
import { createSession, generateToken, SESSION_COOKIE } from "@/lib/auth/session";
import * as dbClient from "@/lib/db/client";
import { upsertBulletinAnalysis } from "@/lib/db/repos/analyses";
import { insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { LEGACY_STAGE2_ANSWER, STAGE2_RATINGS } from "../fixtures/stage2";
import { makeNormalized } from "../helpers/bulletins";
import { createTestDb } from "../helpers/db";

vi.mock("next/navigation", () => ({ useParams: vi.fn() }));
vi.mock("@/components/use-api", () => ({ useApiResource: vi.fn() }));

describe("线报详情二级核验评分（AC5）", () => {
  it.each([
    [
      "新评分",
      { ...LEGACY_STAGE2_ANSWER, ratings: STAGE2_RATINGS },
      ["★★★★☆ 4/5", "★★★★★ 5/5", "★★☆☆☆ 2/5", "★★★☆☆ 3/5", "暂无数据"],
    ],
    [
      "历史越界分与小数分",
      { ...LEGACY_STAGE2_ANSWER, ratings: { ...STAGE2_RATINGS, overall: 0, priceValue: 6, needMatch: 2.5 } },
      ["暂无数据", "暂无数据", "暂无数据", "★★★☆☆ 3/5", "暂无数据"],
    ],
    ["历史字段缺省", LEGACY_STAGE2_ANSWER, null],
    ["历史字段为 null", { ...LEGACY_STAGE2_ANSWER, ratings: null }, null],
  ] as const)("%s经详情 API 返回并展示完整核验记录", async (_scenario, answer, expectedRatings) => {
    const ctx = createTestDb();
    const getDb = vi.spyOn(dbClient, "getDb").mockReturnValue(ctx.db);
    try {
      const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized(), { baseline: false });
      upsertBulletinAnalysis(ctx.db, {
        bulletinId: id,
        triggerSource: "matched",
        status: "succeeded",
        verdict: answer.verdict,
        model: "示例模型",
        baseUrl: "https://llm.example.com/v1",
        activeToolIds: ["calculator"],
        stepsUsed: 2,
        toolCallsCount: 1,
        inputTokens: null,
        outputTokens: null,
        durationMs: 20,
        answer,
        toolTrace: [{
          step: 1,
          toolId: "calculator",
          toolName: "calculate_price",
          arguments: {},
          ok: true,
          infrastructureFailure: false,
          durationMs: 1,
          resultPreview: "计算成功",
        }],
        error: null,
      });
      const token = generateToken();
      createSession(ctx.db, token);
      const path = `/api/bulletins/${id}`;
      const response = await getBulletinDetail(
        new Request(`http://localhost${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(200);
      const { data }: { data: BulletinDetailDto } = await response.json();
      expect(data.analysis?.answer).toEqual(answer);

      vi.mocked(useParams).mockReturnValue({ id });
      vi.mocked(useApiResource).mockReturnValue({ data, error: null, loading: false, reload: vi.fn() });
      const markup = renderToStaticMarkup(
        <MantineProvider>
          <BulletinDetailPage />
        </MantineProvider>,
      );
      expect(useApiResource).toHaveBeenCalledWith(path);
      for (const text of [
        "核验摘要", answer.summary, "29.9 / 24 = 1.25", answer.priceComparison.conclusion,
        answer.orderSteps[0], "需求约束核对", "满足（符合单包预算）", answer.risks[0],
        "查看工具调用轨迹", "calculate_price", "计算成功",
      ]) {
        expect(markup).toContain(text);
      }
      if (expectedRatings) {
        expect(markup).toContain("<h3>量化评分</h3>");
        expect(markup.indexOf("量化评分")).toBeLessThan(markup.indexOf("核验摘要"));
        const labels = ["综合推荐", "价格力度", "需求契合", "下单省心", "低风险度"];
        expectedRatings.forEach((value, index) => {
          expect(markup).toContain(`<dt>${labels[index]}</dt><dd>${value}</dd>`);
        });
      } else {
        expect(markup).not.toMatch(/量化评分|[★☆]/u);
      }
    } finally {
      getDb.mockRestore();
      ctx.close();
    }
  });
});
