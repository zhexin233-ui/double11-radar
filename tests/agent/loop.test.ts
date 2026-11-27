import { describe, expect, it } from "vitest";
import { runStage2AgentLoop } from "@/lib/agent/loop";
import { parseStandardizedAnswer } from "@/lib/agent/schema";
import type { RegisteredTool } from "@/lib/agent/tools/types";
import { LEGACY_STAGE2_ANSWER, STAGE2_RATINGS } from "../fixtures/stage2";

const SAMPLE_BULLETIN = {
  id: "b1",
  title: "维达抽纸 24 包 29.9元",
  content: "下单立减，折合好价",
  price: 29.9,
  brand: "维达",
  mall: "京东",
  category: "日百",
  url: "https://example.com/b1",
};

const VALID_ANSWER = { ...LEGACY_STAGE2_ANSWER, ratings: STAGE2_RATINGS };
const VALID_ANSWER_JSON = JSON.stringify(VALID_ANSWER);

function makeTool(
  pluginId: string,
  functionName: string,
  exec: RegisteredTool["execute"],
): RegisteredTool {
  return {
    pluginId,
    pluginName: pluginId,
    functionName,
    definition: {
      type: "function",
      function: {
        name: functionName,
        description: "mock tool",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: exec,
  };
}

describe("二级模型评分契约（AC1）", () => {
  it("接受 1 至 5 的整数与 null，保留原始评分", () => {
    const answer = { ...VALID_ANSWER, ratings: { ...STAGE2_RATINGS, orderEase: 1 } };
    expect(parseStandardizedAnswer(JSON.stringify(answer))).toEqual({ ok: true, data: answer });
  });

  it.each([
    ["缺少评分对象", undefined, "ratings"],
    ["评分对象为 null", null, "ratings"],
    ["缺少维度", { ...STAGE2_RATINGS, lowRisk: undefined }, "ratings.lowRisk"],
    ["低于 1 分", { ...STAGE2_RATINGS, priceValue: 0 }, "ratings.priceValue"],
    ["超过 5 分", { ...STAGE2_RATINGS, needMatch: 6 }, "ratings.needMatch"],
    ["包含小数", { ...STAGE2_RATINGS, overall: 3.5 }, "ratings.overall"],
    ["分数为字符串", { ...STAGE2_RATINGS, orderEase: "4" }, "ratings.orderEase"],
  ])("拒绝%s的新模型输出", (_scenario, ratings, path) => {
    expect(parseStandardizedAnswer(JSON.stringify({ ...VALID_ANSWER, ratings }))).toMatchObject({
      ok: false,
      error: expect.stringContaining(path),
    });
  });

  it.each(["summary", "productName"])("拒绝只有空白的 %s", (field) => {
    const result = parseStandardizedAnswer(JSON.stringify({ ...VALID_ANSWER, [field]: " \n " }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(field) });
  });
});

describe("agent/loop (AC6 & AC7)", () => {
  it("零工具时自动退化为单轮无 tools 参数请求", async () => {
    let sawToolsParam = false;
    let callCount = 0;
    const res = await runStage2AgentLoop({
      bulletin: SAMPLE_BULLETIN,
      matchedNeeds: [{ id: "n1", name: "抽纸", note: "单包不超过 1.5 元" }],
      tools: [],
      llm: {
        baseUrl: "https://llm.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        timeoutMs: 5000,
        maxSteps: 5,
        temperature: 0.1,
      },
      fetchImpl: async (_url, init) => {
        callCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        if ("tools" in body) sawToolsParam = true;
        expect(body.messages[0].role).toBe("system");
        const prompt = body.messages[0].content;
        for (const rule of ["overall（综合推荐）", "priceValue（价格力度）", "needMatch（需求契合）", "orderEase（下单省心）", "lowRisk（低风险度）", "填 null", "summary 只写一句极简的购买结论"]) {
          expect(prompt).toContain(rule);
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: VALID_ANSWER_JSON } }],
            usage: { prompt_tokens: 50, completion_tokens: 30 },
          }),
          { status: 200 },
        );
      },
    });

    expect(callCount).toBe(1);
    expect(sawToolsParam).toBe(false);
    expect(res.status).toBe("succeeded");
    expect(res.answer?.verdict).toBe("recommended");
    expect(res.answer?.ratings).toEqual(STAGE2_RATINGS);
    expect(res.inputTokens).toBe(50);
  });

  it("单次循环内坏工具即时剔除，后续轮次不再注入坏工具 Schema", async () => {
    const toolsSentPerStep: string[][] = [];
    let step = 0;

    const badTool = makeTool("bad-plugin", "bad_lookup", async () => ({
      ok: false,
      infrastructureFailure: true,
      content: JSON.stringify({ error: "503" }),
      error: "503",
    }));
    const goodTool = makeTool("good-plugin", "good_calc", async () => ({
      ok: true,
      infrastructureFailure: false,
      content: JSON.stringify({ unitPrice: 1.25 }),
    }));

    const res = await runStage2AgentLoop({
      bulletin: SAMPLE_BULLETIN,
      matchedNeeds: [{ id: "n1", name: "抽纸", note: "" }],
      tools: [badTool, goodTool],
      llm: {
        baseUrl: "https://llm.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        timeoutMs: 5000,
        maxSteps: 5,
        temperature: 0.1,
      },
      fetchImpl: async (_url, init) => {
        step += 1;
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
        };
        toolsSentPerStep.push(
          (body.tools ?? []).map((t) => t.function.name),
        );

        if (step === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "tc1",
                        type: "function",
                        function: { name: "bad_lookup", arguments: "{}" },
                      },
                      {
                        id: "tc2",
                        type: "function",
                        function: { name: "good_calc", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: VALID_ANSWER_JSON } }],
          }),
          { status: 200 },
        );
      },
    });

    expect(res.status).toBe("succeeded");
    expect(toolsSentPerStep[0]).toEqual(["bad_lookup", "good_calc"]);
    expect(toolsSentPerStep[1]).toEqual(["good_calc"]);
    expect(res.toolTrace).toHaveLength(2);
  });

  it("达到 maxSteps 强制收敛，且支持最多 1 次 Zod 格式修正", async () => {
    let callIdx = 0;
    const goodTool = makeTool("good-plugin", "good_calc", async () => ({
      ok: true,
      infrastructureFailure: false,
      content: "{}",
    }));

    const res = await runStage2AgentLoop({
      bulletin: SAMPLE_BULLETIN,
      matchedNeeds: [{ id: "n1", name: "抽纸", note: "" }],
      tools: [goodTool],
      llm: {
        baseUrl: "https://llm.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        timeoutMs: 5000,
        maxSteps: 1,
        temperature: 0.1,
      },
      fetchImpl: async () => {
        callIdx += 1;
        if (callIdx === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "tc1",
                        type: "function",
                        function: { name: "good_calc", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (callIdx === 2) {
          // 强制收敛遗漏新模型输出必填的评分对象。
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(LEGACY_STAGE2_ANSWER) } }],
            }),
            { status: 200 },
          );
        }
        // 第 3 次为格式修正请求，返回合法 JSON
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: VALID_ANSWER_JSON } }],
          }),
          { status: 200 },
        );
      },
    });

    expect(callIdx).toBe(3);
    expect(res.status).toBe("succeeded");
  });

  it("两次格式校验均失败时返回 failed，不伪造推荐结论", async () => {
    const res = await runStage2AgentLoop({
      bulletin: SAMPLE_BULLETIN,
      matchedNeeds: [{ id: "n1", name: "抽纸", note: "" }],
      tools: [],
      llm: {
        baseUrl: "https://llm.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        timeoutMs: 5000,
        maxSteps: 5,
        temperature: 0.1,
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "not a json" } }],
          }),
          { status: 200 },
        ),
    });

    expect(res.status).toBe("failed");
    expect(res.answer).toBeNull();
    expect(res.error).toBeTruthy();
  });
});
