import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrate } from "@/lib/db/migrate";
import { GET as getStorage, PUT as putStorage } from "@/app/api/settings/storage/route";
import { POST as cleanupStorage } from "@/app/api/settings/storage/cleanup/route";
import { POST as vacuumStorage } from "@/app/api/settings/storage/vacuum/route";
import { createSession, generateToken } from "@/lib/auth/session";
import { closeDb, getDb } from "@/lib/db/client";
import { NextRequest } from "next/server";

describe("storage api routes", () => {
  let tmpDir: string;
  let token: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-api-storage-"));
    process.env.DATA_DIR = tmpDir;
    closeDb();
    const db = getDb();
    migrate(db);
    token = generateToken();
    createSession(db, token);
  });

  afterEach(() => {
    try {
      closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeRequest(
    url: string,
    method = "GET",
    body?: unknown,
  ): NextRequest {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("cookie", `xianbao_session=${token}`);
    headers.set("origin", "http://localhost:3000");
    headers.set("host", "localhost:3000");
    headers.set("x-requested-with", "fetch");

    return new NextRequest(new URL(url, "http://localhost:3000"), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("should get storage settings and stats", async () => {
    const req = makeRequest("http://localhost:3000/api/settings/storage");
    const res = await getStorage(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data.settings.retentionDays).toBe(30);
    expect(typeof data.data.stats.totalSizeBytes).toBe("number");
  });

  it("should update storage settings", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/settings/storage",
      "PUT",
      {
        retentionDays: 14,
        autoCleanupEnabled: false,
        cleanOnlyUnmatched: true,
      },
    );
    const res = await putStorage(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data.settings.retentionDays).toBe(14);
    expect(data.data.settings.autoCleanupEnabled).toBe(false);
    expect(data.data.settings.cleanOnlyUnmatched).toBe(true);
  });

  it("should execute cleanup via api", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/settings/storage/cleanup",
      "POST",
      { retentionDays: 7 },
    );
    const res = await cleanupStorage(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.data.cleanedBulletins).toBe("number");
  });

  it("should execute vacuum via api", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/settings/storage/vacuum",
      "POST",
      {},
    );
    const res = await vacuumStorage(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.data.success).toBe(true);
  });
});
