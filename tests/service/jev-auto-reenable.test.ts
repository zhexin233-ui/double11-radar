import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createTestDb, testKey } from "../helpers/db";
import { addJevKey, removeJevKey, updateJevKeySettings } from "@/lib/service/jev-keys";
import { getJevKey, reenableDueJevKeys, updateJevKey } from "@/lib/db/repos/jev-keys";
import { completeJevRequest, insertInFlightRequest } from "@/lib/db/repos/jev-requests";
import { clearSecret } from "@/lib/db/repos/settings";
import { listRecentSystemAlerts } from "@/lib/db/repos/system-alerts";
import { formatSystemAlert } from "@/lib/system-alerts/format";
import { reserveJevCall } from "@/lib/service/jev-requests";
import { saveJevConfig, saveNotifyConfig } from "@/lib/service/config";
import { runSystemAlertDelivererOnce } from "@/lib/worker/system-alert-deliverer";

const KEY = testKey();
const NOW = new Date("2026-10-29T00:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
type Db = ReturnType<typeof createTestDb>["db"];
type Key = { id: string; label: string; generation: number };
function request(db: Db, key: Key, now = NOW) {
  return insertInFlightRequest(db, { keyId: key.id, keyLabel: key.label, keyGeneration: key.generation,
    purpose: "test", requestedModel: "jev-latest", providerOrigin: null, configVersion: 1,
    startedAt: now, leaseUntil: new Date(now.getTime() + 60_000) });
}
function fail(db: Db, key: Key, now = NOW) {
  return completeJevRequest(db, { id: request(db, key, now).id, status: "failed", now,
    httpStatus: 401, errorMessage: "测试失败", errorCode: "auth" });
}
function disable(db: Db, key: Key, now = NOW) {
  for (let i = 0; i < 10; i++) fail(db, key, now);
}
function add(db: Db, minutes = 5) {
  return addJevKey(db, { label: "自动密钥", apiKey: "sk-test-auto", autoReenableEnabled: true, autoReenableMinutes: minutes }, KEY);
}

describe("单密钥自动重新启用（A1～A6）", () => {
  it("重复启用已启用密钥保留健康状态与generation，手动恢复仅转换一次", () => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db, 1);
      fail(ctx.db, key);
      const pending = request(ctx.db, key);
      updateJevKeySettings(ctx.db, key.id, { enabled: true }, KEY);
      updateJevKeySettings(ctx.db, key.id, { enabled: true, autoReenableMinutes: 2 }, KEY);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, generation: 1,
        consecutiveFailures: 1, lastError: "测试失败", autoReenableMinutes: 2 });
      completeJevRequest(ctx.db, { id: pending.id, status: "failed", now: NOW, errorMessage: "在途请求失败" });
      expect(getJevKey(ctx.db, key.id)?.consecutiveFailures).toBe(2);
      for (let i = 0; i < 8; i++) fail(ctx.db, key);
      expect(getJevKey(ctx.db, key.id)?.enabled).toBe(false);
      updateJevKeySettings(ctx.db, key.id, { enabled: true }, KEY);
      updateJevKeySettings(ctx.db, key.id, { enabled: true }, KEY);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, generation: 2,
        consecutiveFailures: 0, autoDisabledAt: null, autoReenableAt: null });
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(1);
    } finally { ctx.close(); }
  });

  it("默认关闭，两个密钥独立设置；服务拒绝非法配置且不写入", () => {
    const ctx = createTestDb();
    try {
      const a = addJevKey(ctx.db, { label: "默认", apiKey: "sk-default" }, KEY);
      const b = add(ctx.db, 1440);
      expect(a).toMatchObject({ autoReenableEnabled: false, autoReenableMinutes: 5, autoDisabledAt: null, autoReenableAt: null });
      expect(getJevKey(ctx.db, b.id)).toMatchObject({ autoReenableEnabled: true, autoReenableMinutes: 1440 });
      updateJevKeySettings(ctx.db, b.id, { autoReenableMinutes: 1 }, KEY);
      expect(getJevKey(ctx.db, a.id)?.autoReenableMinutes).toBe(5);
      for (const value of [null, "", "5", 0, 1.1, 1441, true]) {
        const input = JSON.parse(JSON.stringify({ autoReenableMinutes: value }));
        expect(() => updateJevKeySettings(ctx.db, b.id, input, KEY)).toThrow();
      }
      expect(getJevKey(ctx.db, b.id)?.autoReenableMinutes).toBe(1);
    } finally { ctx.close(); }
  });

  it("第9次不等待，第10次开始；到期边界只执行一次，后续周期照常恢复", () => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db);
      for (let i = 0; i < 9; i++) fail(ctx.db, key);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, autoDisabledAt: null, autoReenableAt: null });
      fail(ctx.db, key);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: false, autoDisabledAt: NOW.toISOString(), autoReenableAt: at(5).toISOString() });
      expect(reenableDueJevKeys(ctx.db, new Date(at(5).getTime() - 1))).toBe(0);
      expect(reenableDueJevKeys(ctx.db, at(5))).toBe(1);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: true, generation: 2, consecutiveFailures: 0,
        autoDisabledAt: null, autoReenableAt: null, lastError: null, disabledReason: null });
      expect(reenableDueJevKeys(ctx.db, at(6))).toBe(0);
      const restored = getJevKey(ctx.db, key.id)!;
      disable(ctx.db, restored, at(6));
      expect(getJevKey(ctx.db, key.id)?.autoReenableAt).toBe(at(11).toISOString());
      expect(reenableDueJevKeys(ctx.db, at(12))).toBe(1);
      expect(getJevKey(ctx.db, key.id)?.generation).toBe(3);
      const events = listRecentSystemAlerts(ctx.db);
      expect(events.filter((event) => event.eventType === "key_auto_disabled")).toHaveLength(2);
      expect(events.filter((event) => event.eventType === "key_auto_reenabled")).toHaveLength(2);
    } finally { ctx.close(); }
  });

  it("修改间隔按原起点重算、改名不重置，关闭再开启保留自动禁用来源", () => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db);
      disable(ctx.db, key);
      updateJevKeySettings(ctx.db, key.id, { label: "改名" }, KEY);
      expect(getJevKey(ctx.db, key.id)?.autoReenableAt).toBe(at(5).toISOString());
      updateJevKeySettings(ctx.db, key.id, { autoReenableMinutes: 10 }, KEY);
      expect(getJevKey(ctx.db, key.id)?.autoReenableAt).toBe(at(10).toISOString());
      expect(reenableDueJevKeys(ctx.db, at(6))).toBe(0);
      updateJevKeySettings(ctx.db, key.id, { autoReenableEnabled: false }, KEY);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ autoDisabledAt: NOW.toISOString(), autoReenableAt: null });
      expect(reenableDueJevKeys(ctx.db, at(20))).toBe(0);
      updateJevKeySettings(ctx.db, key.id, { autoReenableEnabled: true, autoReenableMinutes: 1 }, KEY);
      expect(getJevKey(ctx.db, key.id)?.autoReenableAt).toBe(at(1).toISOString());
      expect(reenableDueJevKeys(ctx.db, at(2))).toBe(1);
    } finally { ctx.close(); }
  });

  it("未开启时也记录真实禁用起点，后开启可恢复；历史来源不明和人工停用不建计划", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "后开启", apiKey: "sk-off" }, KEY);
      disable(ctx.db, key);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ autoDisabledAt: NOW.toISOString(), autoReenableAt: null });
      updateJevKeySettings(ctx.db, key.id, { autoReenableEnabled: true }, KEY);
      expect(getJevKey(ctx.db, key.id)?.autoReenableAt).toBe(at(5).toISOString());
      const old = add(ctx.db);
      updateJevKey(ctx.db, old.id, { enabled: false, disabledReason: "连续10次失败的历史记录", consecutiveFailures: 10 });
      updateJevKeySettings(ctx.db, old.id, { autoReenableEnabled: true }, KEY);
      expect(getJevKey(ctx.db, old.id)?.autoReenableAt).toBeNull();
      updateJevKeySettings(ctx.db, key.id, { enabled: false }, KEY);
      updateJevKeySettings(ctx.db, key.id, { autoReenableEnabled: false }, KEY);
      updateJevKeySettings(ctx.db, key.id, { autoReenableEnabled: true }, KEY);
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: false, autoDisabledAt: null, autoReenableAt: null, disabledReason: "管理员已手动停用" });
      expect(reenableDueJevKeys(ctx.db, at(20))).toBe(0);
    } finally { ctx.close(); }
  });

  it.each(["replace", "clear", "manual", "delete", "missing"])("%s 取消旧周期且不发送恢复通知", (action) => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db);
      disable(ctx.db, key);
      if (action === "replace") updateJevKeySettings(ctx.db, key.id, { apiKey: "sk-replaced" }, KEY);
      if (action === "clear") {
        updateJevKeySettings(ctx.db, key.id, { apiKey: { clear: true }, enabled: true }, KEY);
        expect(getJevKey(ctx.db, key.id)?.enabled).toBe(false);
      }
      if (action === "manual") updateJevKeySettings(ctx.db, key.id, { enabled: true }, KEY);
      if (action === "delete") removeJevKey(ctx.db, key.id);
      if (action === "missing") clearSecret(ctx.db, getJevKey(ctx.db, key.id)!.secretNamespace);
      expect(reenableDueJevKeys(ctx.db, at(20))).toBe(0);
      if (action === "replace") expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: false, autoDisabledAt: null, autoReenableAt: null });
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(1);
    } finally { ctx.close(); }
  });

  it("恢复保留有效限流，旧generation成功/失败/429只补记原账本，不污染新密钥状态", () => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db, 1);
      const lateSuccess = request(ctx.db, key);
      const lateFailure = request(ctx.db, key);
      disable(ctx.db, key);
      updateJevKey(ctx.db, key.id, { cooldownUntil: at(10).toISOString() });
      expect(reenableDueJevKeys(ctx.db, at(1))).toBe(1);
      const before = getJevKey(ctx.db, key.id);
      completeJevRequest(ctx.db, { id: lateSuccess.id, status: "succeeded", now: at(2) });
      completeJevRequest(ctx.db, { id: lateFailure.id, status: "failed", now: at(2), rateLimited: true, retryAfterMs: 60_000 });
      expect(getJevKey(ctx.db, key.id)).toEqual(before);
      saveJevConfig(ctx.db, { model: "jev-latest", baseUrl: "https://api.typesafe.ai" }, KEY);
      expect(reserveJevCall(ctx.db, { purpose: "test", preferredKeyId: key.id, now: at(2) }, KEY)).toMatchObject({ ok: false, reason: "cooldown" });
    } finally { ctx.close(); }
  });

  it("事件写入失败则整次恢复回滚，重开数据库补处理保持唯一且不创建新账本", () => {
    const ctx = createTestDb();
    let reopened: Database.Database | undefined;
    try {
      const key = add(ctx.db, 1);
      disable(ctx.db, key);
      ctx.db.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON system_alerts WHEN NEW.event_type = 'key_auto_reenabled' BEGIN SELECT RAISE(ABORT,'测试回滚'); END");
      expect(() => reenableDueJevKeys(ctx.db, at(1))).toThrow("测试回滚");
      expect(getJevKey(ctx.db, key.id)).toMatchObject({ enabled: false, generation: 1, consecutiveFailures: 10 });
      ctx.db.exec("DROP TRIGGER reject_recovery");
      reopened = new Database(ctx.dbPath);
      expect(reenableDueJevKeys(reopened, at(2))).toBe(1);
      expect(reenableDueJevKeys(ctx.db, at(2))).toBe(0);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM jev_requests").get()).toEqual({ n: 10 });
      const event = listRecentSystemAlerts(ctx.db).find((alert) => alert.eventType === "key_auto_reenabled")!;
      expect(event).toMatchObject({ keyGeneration: 2, consecutiveFailures: 10, errorCategory: null, httpStatus: null });
      const message = formatSystemAlert(event);
      expect(message.title).toBe("模型密钥已自动重新启用");
      expect(message.lines.join("\n")).toContain("未验证实际可用");
      expect(message.lines.join("\n")).toContain(at(2).toISOString());
      expect(JSON.stringify(message)).not.toContain("sk-test-auto");
    } finally { reopened?.close(); ctx.close(); }
  });

  it("恢复通知复用渠道快照、无渠道终态与部分渠道有限重试", async () => {
    const ctx = createTestDb();
    try {
      const key = add(ctx.db, 1);
      disable(ctx.db, key);
      // 原禁用事件无渠道；后续配置仅用于新的恢复事件。
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW });
      expect(listRecentSystemAlerts(ctx.db)[0].dispatchStatus).toBe("no_channels");
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "device" }, feishu: { enabled: true, webhook: "https://open.feishu.cn/hook/test" } }, KEY);
      reenableDueJevKeys(ctx.db, at(1));
      const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({ code: String(url).includes("feishu") ? 11232 : 200 })));
      for (let attempt = 0; attempt < 5; attempt++) {
        await runSystemAlertDelivererOnce(ctx.db, { key: KEY, fetchImpl, now: () => at(1 + attempt * 10) });
      }
      const event = listRecentSystemAlerts(ctx.db).find((alert) => alert.eventType === "key_auto_reenabled")!;
      expect(event.deliveries.map((delivery) => [delivery.channel, delivery.status, delivery.attempts]))
        .toEqual([["bark", "succeeded", 1], ["feishu", "dead", 5]]);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      const barkCall = fetchImpl.mock.calls.find(([url]) => !String(url).includes("feishu"));
      expect(barkCall).toBeDefined();
    } finally { ctx.close(); }
  });
});
