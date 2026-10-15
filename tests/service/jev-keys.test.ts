import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { LEGACY_JEV_KEY_ID } from "@/lib/db/migrations";
import { getJevKey, listJevKeys, updateJevKey } from "@/lib/db/repos/jev-keys";
import { insertInFlightRequest } from "@/lib/db/repos/jev-requests";
import { getSecret } from "@/lib/db/repos/settings";
import { getJevRuntimeConfig, saveJevConfig } from "@/lib/service/config";
import {
  addJevKey,
  getJevKeyView,
  jevKeySecretNamespace,
  listJevKeyViews,
  removeJevKey,
  updateJevKeySettings,
} from "@/lib/service/jev-keys";

/**
 * Jev Key 池服务层（AC1/AC2）。
 *
 * 只覆盖持久化、事务语义、掩码与兼容层；不连接任何真实上游。
 * 明文只在服务端通过 `getSecret` 读取，网页视图必须始终是掩码。
 */

const KEY = testKey();

function countKeys(db: ReturnType<typeof createTestDb>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM jev_api_keys").get() as { c: number }).c;
}

function countRequests(db: ReturnType<typeof createTestDb>["db"]): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM jev_requests").get() as { c: number }).c;
}

function insertLedger(
  ctx: ReturnType<typeof createTestDb>,
  keyId: string,
  keyLabel: string,
  generation: number,
): string {
  const now = new Date("2026-10-14T00:00:00.000Z");
  return insertInFlightRequest(ctx.db, {
    keyId,
    keyLabel,
    keyGeneration: generation,
    purpose: "evaluate",
    requestedModel: "jev-latest",
    providerOrigin: "https://api.typesafe.ai",
    configVersion: 1,
    startedAt: now,
    leaseUntil: new Date(now.getTime() + 60_000),
  }).id;
}

describe("Jev Key 新增与读取（AC1）", () => {
  it("新增后元数据与密文同时落库，网页视图只返回掩码", () => {
    const ctx = createTestDb();
    try {
      const view = addJevKey(
        ctx.db,
        { label: "主密钥", apiKey: "sk-plain-abcdef" },
        KEY,
      );
      expect(countKeys(ctx.db)).toBe(1);
      expect(getSecret(ctx.db, jevKeySecretNamespace(view.id), KEY)).toBe(
        "sk-plain-abcdef",
      );

      const views = listJevKeyViews(ctx.db, KEY);
      expect(views).toHaveLength(1);
      expect(views[0].secretState).toEqual({
        configured: true,
        masked: "****cdef",
        unreadable: false,
      });
      // 整体 JSON 不含明文密钥
      expect(JSON.stringify(views)).not.toContain("sk-plain-abcdef");
      expect(JSON.stringify(getJevKeyView(ctx.db, view.id, KEY))).not.toContain(
        "sk-plain-abcdef",
      );
    } finally {
      ctx.close();
    }
  });
});

describe("替换、恢复与停用（AC1/AC2）", () => {
  it("替换密钥：generation 自增、计数清零、禁用原因清空，但不隐式改变启停状态", () => {
    const ctx = createTestDb();
    try {
      const view = addJevKey(ctx.db, { label: "A", apiKey: "sk-old-1111" }, KEY);
      updateJevKeySettings(ctx.db, view.id, { enabled: false }, KEY);
      updateJevKey(ctx.db, view.id, {
        consecutiveFailures: 2,
        disabledReason: "旧原因",
      });
      const before = getJevKey(ctx.db, view.id)!;

      const replaced = updateJevKeySettings(
        ctx.db,
        view.id,
        { apiKey: "sk-new-2222" },
        KEY,
      )!;
      expect(replaced.generation).toBe(before.generation + 1);
      expect(replaced.consecutiveFailures).toBe(0);
      expect(replaced.disabledReason).toBeNull();
      // 被禁用的 Key 替换后仍然禁用
      expect(replaced.enabled).toBe(false);
      expect(getSecret(ctx.db, jevKeySecretNamespace(view.id), KEY)).toBe(
        "sk-new-2222",
      );
    } finally {
      ctx.close();
    }
  });

  it("手动恢复已禁用的 Key：generation 自增、计数清零、禁用原因清空", () => {
    const ctx = createTestDb();
    try {
      const view = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      updateJevKeySettings(ctx.db, view.id, { enabled: false }, KEY);
      updateJevKey(ctx.db, view.id, {
        consecutiveFailures: 3,
        lastError: "旧失败",
      });

      const restored = updateJevKeySettings(
        ctx.db,
        view.id,
        { enabled: true },
        KEY,
      )!;
      expect(restored.enabled).toBe(true);
      expect(restored.consecutiveFailures).toBe(0);
      expect(restored.disabledReason).toBeNull();
      expect(restored.lastError).toBeNull();
      expect(restored.generation).toBe(view.generation + 1);
    } finally {
      ctx.close();
    }
  });

  it("手动停用：记录中文原因", () => {
    const ctx = createTestDb();
    try {
      const view = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const disabled = updateJevKeySettings(
        ctx.db,
        view.id,
        { enabled: false },
        KEY,
      )!;
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabledReason).toMatch(/[\u4e00-\u9fff]/);
    } finally {
      ctx.close();
    }
  });
});

describe("清除与删除（AC2）", () => {
  it("清除密钥：不再可解密且 Key 停用，其它 Key 与历史账本不受影响", () => {
    const ctx = createTestDb();
    try {
      const a = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const b = addJevKey(ctx.db, { label: "B", apiKey: "sk-b" }, KEY);
      const ledgerId = insertLedger(ctx, a.id, a.label, a.generation);

      const cleared = updateJevKeySettings(
        ctx.db,
        a.id,
        { apiKey: { clear: true } },
        KEY,
      )!;
      expect(cleared.enabled).toBe(false);
      expect(getSecret(ctx.db, jevKeySecretNamespace(a.id), KEY)).toBeNull();
      // 另一个 Key 的密文与启用状态不受影响
      expect(getSecret(ctx.db, jevKeySecretNamespace(b.id), KEY)).toBe("sk-b");
      expect(getJevKey(ctx.db, b.id)!.enabled).toBe(true);
      // 历史账本保留
      expect(countRequests(ctx.db)).toBe(1);
      expect(
        ctx.db.prepare("SELECT COUNT(*) AS c FROM jev_requests WHERE id = ?").get(ledgerId),
      ).toEqual({ c: 1 });
    } finally {
      ctx.close();
    }
  });

  it("删除 Key：元数据消失，调用账本历史行仍保留", () => {
    const ctx = createTestDb();
    try {
      const a = addJevKey(ctx.db, { label: "A", apiKey: "sk-a" }, KEY);
      const ledgerId = insertLedger(ctx, a.id, a.label, a.generation);

      expect(removeJevKey(ctx.db, a.id)).toBe(true);
      expect(getJevKey(ctx.db, a.id)).toBeNull();
      expect(countKeys(ctx.db)).toBe(0);
      expect(countRequests(ctx.db)).toBe(1);
      // 账本仍保留非敏感 id/label 快照
      const ledger = ctx.db
        .prepare("SELECT key_id, key_label FROM jev_requests WHERE id = ?")
        .get(ledgerId) as { key_id: string; key_label: string };
      expect(ledger.key_id).toBe(a.id);
      expect(ledger.key_label).toBe("A");
    } finally {
      ctx.close();
    }
  });
});

describe("旧单 Key 兼容层（AC1/AC2）", () => {
  it("saveJevConfig 写入固定兼容 Key，清除后运行时为空，只改普通配置不重置状态", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-legacy-1234" }, KEY);
      const legacy = getJevKey(ctx.db, LEGACY_JEV_KEY_ID);
      expect(legacy).not.toBeNull();
      expect(legacy!.enabled).toBe(true);
      expect(getJevRuntimeConfig(ctx.db, KEY)?.apiKey).toBe("sk-legacy-1234");

      saveJevConfig(ctx.db, { apiKey: { clear: true } }, KEY);
      expect(getJevRuntimeConfig(ctx.db, KEY)).toBeNull();
      expect(getJevKey(ctx.db, LEGACY_JEV_KEY_ID)!.enabled).toBe(false);

      // 造一个失败计数，再只改普通配置：不得清零，也不得误启用
      updateJevKey(ctx.db, LEGACY_JEV_KEY_ID, { consecutiveFailures: 2 });
      saveJevConfig(ctx.db, { model: "jev-custom" }, KEY);
      const after = getJevKey(ctx.db, LEGACY_JEV_KEY_ID)!;
      expect(after.enabled).toBe(false);
      expect(after.consecutiveFailures).toBe(2);
      expect(after.disabledReason).not.toBeNull();
      expect(getJevRuntimeConfig(ctx.db, KEY)).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("重启后 Key 与失败计数仍然保留", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-keys-"));
    const dbPath = path.join(dir, "test.db");
    const key = testKey();
    try {
      const first = getDb(dbPath);
      migrate(first);
      const view = addJevKey(first, { label: "持久", apiKey: "sk-persist" }, key);
      updateJevKey(first, view.id, { consecutiveFailures: 2 });
      closeDb();

      const second = getDb(dbPath);
      migrate(second);
      const rows = listJevKeys(second);
      expect(rows).toHaveLength(1);
      expect(rows[0].consecutiveFailures).toBe(2);
      expect(getSecret(second, rows[0].secretNamespace, key)).toBe("sk-persist");
      closeDb();
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
