import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { createSession, generateToken } from "@/lib/auth/session";
import {
  GET as getStage2Settings,
  PUT as putStage2Settings,
} from "@/app/api/settings/stage2/route";
import { POST as testStage2Llm } from "@/app/api/settings/stage2/test-llm/route";
import { POST as createTool } from "@/app/api/settings/stage2/tools/route";
import {
  PUT as updateTool,
  DELETE as deleteTool,
} from "@/app/api/settings/stage2/tools/[id]/route";

function makeReq(
  url: string,
  method: string,
  body?: unknown,
  token?: string,
  origin = "http://localhost:3000",
) {
  return new Request(url, {
    method,
    headers: {
      origin,
      host: "localhost:3000",
      "x-requested-with": "fetch",
      "content-type": "application/json",
      cookie: token ? `xianbao_session=${token}` : "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("http/stage2-api (AC9)", () => {
  it("校验鉴权与同源、三态密钥掩码、外部工具 CRUD 与内置插件防删除", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-api-"));
    vi.stubEnv("DATA_DIR", dir);
    const db = getDb();
    migrate(db);
    try {
      const token = generateToken();
      createSession(db, token);
      const emptyCtx = { params: Promise.resolve({}) };

      // 1. 未认证 / 跨站拒绝
      expect(
        (
          await getStage2Settings(
            makeReq("http://localhost:3000/api/settings/stage2", "GET"),
            emptyCtx,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await putStage2Settings(
            makeReq(
              "http://localhost:3000/api/settings/stage2",
              "PUT",
              { enabled: true },
              token,
              "https://evil.example",
            ),
            emptyCtx,
          )
        ).status,
      ).toBe(403);

      // 2. 更新二级配置与三态密钥（绝不返回明文）
      const putRes = await putStage2Settings(
        makeReq(
          "http://localhost:3000/api/settings/stage2",
          "PUT",
          {
            enabled: true,
            apiKey: "sk-stage2-super-secret",
            llm: { model: "gpt-4o", maxSteps: 6, timeoutMs: 180_000 },
          },
          token,
        ),
        emptyCtx,
      );
      expect(putRes.status).toBe(200);
      const putJson = await putRes.json();
      expect(putJson.data.config.enabled).toBe(true);
      expect(putJson.data.config.llm.model).toBe("gpt-4o");
      expect(putJson.data.config.llm.timeoutMs).toBe(180_000);
      expect(putJson.data.apiKeyState.configured).toBe(true);
      expect(JSON.stringify(putJson)).not.toContain("sk-stage2-super-secret");

      const fetchImpl = vi.fn(async () =>
        Response.json({ choices: [{ message: { content: "OK" } }] }),
      );
      vi.stubGlobal("fetch", fetchImpl);
      const testRes = await testStage2Llm(
        makeReq(
          "http://localhost:3000/api/settings/stage2/test-llm",
          "POST",
          { timeoutMs: 180_000 },
          token,
        ),
        emptyCtx,
      );
      expect(testRes.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // 3. 新增外部 HTTP 工具
      const createRes = await createTool(
        makeReq(
          "http://localhost:3000/api/settings/stage2/tools",
          "POST",
          {
            name: "测试比价接口",
            kind: "http_api",
            config: {
              functionName: "check_ext_price",
              description: "查询外部历史价格",
              endpointUrl: "https://api.example.com/price",
              method: "GET",
            },
            secret: "tool-secret-token",
          },
          token,
        ),
        emptyCtx,
      );
      expect(createRes.status).toBe(201);
      const createJson = await createRes.json();
      const toolId = createJson.data.tool.id as string;
      expect(createJson.data.tool.secretState.configured).toBe(true);
      expect(JSON.stringify(createJson)).not.toContain("tool-secret-token");

      // 4. 更新与删除外部工具
      const toolCtx = { params: Promise.resolve({ id: toolId }) };
      const updRes = await updateTool(
        makeReq(
          `http://localhost:3000/api/settings/stage2/tools/${toolId}`,
          "PUT",
          { enabled: false },
          token,
        ),
        toolCtx,
      );
      expect(updRes.status).toBe(200);
      expect((await updRes.json()).data.tool.enabled).toBe(false);

      const delRes = await deleteTool(
        makeReq(
          `http://localhost:3000/api/settings/stage2/tools/${toolId}`,
          "DELETE",
          undefined,
          token,
        ),
        toolCtx,
      );
      expect(delRes.status).toBe(200);

      // 5. 拒绝删除内置插件
      const builtinDelRes = await deleteTool(
        makeReq(
          "http://localhost:3000/api/settings/stage2/tools/builtin-calculator",
          "DELETE",
          undefined,
          token,
        ),
        { params: Promise.resolve({ id: "builtin-calculator" }) },
      );
      expect(builtinDelRes.status).toBe(400);
    } finally {
      closeDb();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
