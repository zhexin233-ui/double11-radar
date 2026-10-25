import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { GET as getGroups, POST as postGroup } from "@/lib/../app/api/need-groups/route";
import {
  PATCH as patchGroup,
  DELETE as deleteGroup,
} from "@/lib/../app/api/need-groups/[id]/route";
import { POST as postNeed, GET as getNeeds } from "@/lib/../app/api/needs/route";
import { NextRequest } from "next/server";
import { createSession, generateToken } from "@/lib/auth/session";

function createAuthReq(
  url: string,
  options: {
    method?: string;
    body?: any;
    token?: string;
  } = {},
) {
  const headers = new Headers();
  headers.set("origin", "http://localhost:3000");
  headers.set("host", "localhost:3000");
  headers.set("x-requested-with", "fetch");
  if (options.token) {
    headers.set("cookie", `xianbao_session=${options.token}`);
  }
  if (options.body) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe("api/need-groups", () => {
  it("CRUD 分组及关联聚合查询", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-api-test-"));
    process.env.DATA_DIR = dir;
    closeDb();
    const db = getDb();
    migrate(db);
    try {
      const token = generateToken();
      createSession(db, token);

      // 1. 创建分组
      const postReq = createAuthReq("/api/need-groups", {
        method: "POST",
        body: { name: "日常百货", enabled: true, orderNum: 5 },
        token,
      });
      const postRes = await postGroup(postReq, { params: Promise.resolve({}) });
      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.data.group.name).toBe("日常百货");
      const groupId = postData.data.group.id;

      // 2. 创建组内需求
      const needReq = createAuthReq("/api/needs", {
        method: "POST",
        body: { groupId, name: "抽纸", note: "只要清风" },
        token,
      });
      const needRes = await postNeed(needReq, { params: Promise.resolve({}) });
      expect(needRes.status).toBe(201);

      // 3. GET 分组包含需求
      const getReq = createAuthReq("/api/need-groups?includeNeeds=true", {
        token,
      });
      const getRes = await getGroups(getReq, { params: Promise.resolve({}) });
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      const targetGroup = getData.data.groups.find((g: any) => g.id === groupId);
      expect(targetGroup).toBeDefined();
      expect(targetGroup.needs).toHaveLength(1);
      expect(targetGroup.needs[0].name).toBe("抽纸");

      // 4. PATCH 更新分组
      const patchReq = createAuthReq(`/api/need-groups/${groupId}`, {
        method: "PATCH",
        body: { enabled: false },
        token,
      });
      const patchRes = await patchGroup(patchReq, {
        params: Promise.resolve({ id: groupId }),
      });
      expect(patchRes.status).toBe(200);
      const patchData = await patchRes.json();
      expect(patchData.data.group.enabled).toBe(false);

      // 5. DELETE 级联删除
      const delReq = createAuthReq(`/api/need-groups/${groupId}`, {
        method: "DELETE",
        token,
      });
      const delRes = await deleteGroup(delReq, {
        params: Promise.resolve({ id: groupId }),
      });
      expect(delRes.status).toBe(200);

      // 验证需求已不存在
      const checkNeedsReq = createAuthReq(`/api/needs?groupId=${groupId}`, {
        token,
      });
      const checkNeedsRes = await getNeeds(checkNeedsReq, { params: Promise.resolve({}) });
      const checkNeedsData = await checkNeedsRes.json();
      expect(checkNeedsData.data.items).toHaveLength(0);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
