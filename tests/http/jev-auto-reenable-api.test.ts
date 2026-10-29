import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { createSession, generateToken } from "@/lib/auth/session";
import { POST } from "@/app/api/settings/jev/keys/route";
import { PATCH } from "@/app/api/settings/jev/keys/[id]/route";
import { GET as getStatus } from "@/app/api/status/route";
import { insertSystemAlert } from "@/lib/db/repos/system-alerts";

function req(method: string, body?: unknown, token?: string, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/settings/jev/keys", { method,
    headers: { origin, host: "localhost:3000", "x-requested-with": "fetch", "content-type": "application/json",
      cookie: token ? `xianbao_session=${token}` : "" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("自动重新启用配置API", () => {
  it("持久化默认与边界值，拒绝非法类型/只读时间，保持鉴权和同源检查", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-reenable-api-"));
    vi.stubEnv("DATA_DIR", dir);
    const db = getDb();
    migrate(db);
    try {
      const token = generateToken();
      createSession(db, token);
      const ctx = { params: Promise.resolve({}) };
      const body = { label: "默认", apiKey: "sk-no-plaintext" };
      expect((await POST(req("POST", body), ctx)).status).toBe(401);
      expect((await POST(req("POST", body, token, "https://other.example"), ctx)).status).toBe(403);
      const created = await POST(req("POST", body, token), ctx);
      const createdBody = await created.json();
      expect(createdBody.data).toMatchObject({ autoReenableEnabled: false, autoReenableMinutes: 5, autoReenableAt: null, autoDisabledAt: null });
      expect(JSON.stringify(createdBody)).not.toContain("sk-no-plaintext");
      const id = createdBody.data.id as string;
      const patchCtx = { params: Promise.resolve({ id }) };
      for (const minutes of [1, 1440]) {
        const response = await PATCH(req("PATCH", { autoReenableEnabled: true, autoReenableMinutes: minutes }, token), patchCtx);
        expect(response.status).toBe(200);
        expect((await response.json()).data).toMatchObject({ autoReenableEnabled: true, autoReenableMinutes: minutes });
      }
      for (const input of [
        ...[null, "", "5", 0, 1.5, 1441, false].map((autoReenableMinutes) => ({ autoReenableMinutes })),
        ...[null, "true", 1].map((autoReenableEnabled) => ({ autoReenableEnabled })),
        { autoDisabledAt: "2026-10-29T00:00:00.000Z" }, { autoReenableAt: null },
      ]) {
        expect((await PATCH(req("PATCH", input, token), patchCtx)).status).toBe(400);
        expect((await POST(req("POST", { ...body, ...input }, token), ctx)).status).toBe(400);
      }
      expect((await PATCH(req("PATCH", { autoReenableEnabled: false }, token), patchCtx)).status).toBe(200);
      insertSystemAlert(db, { eventType: "key_auto_reenabled", keyId: id, keyGeneration: 2, channelName: "渠道", keyLabel: "默认",
        consecutiveFailures: 10, occurredAt: new Date().toISOString(), errorCategory: null, httpStatus: null });
      const status = await getStatus(req("GET", undefined, token), ctx);
      const statusBody = await status.json();
      expect(statusBody.data.systemAlerts[0]).toMatchObject({ eventType: "key_auto_reenabled", reason: expect.stringContaining("未验证实际可用") });
      expect(statusBody.data.systemAlerts[0]).not.toHaveProperty("keyId");
    } finally { closeDb(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
