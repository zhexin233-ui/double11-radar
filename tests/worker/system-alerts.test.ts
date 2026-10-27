import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createTestDb, testKey } from "../helpers/db";
import { addJevKey, updateJevKeySettings, removeJevKey } from "@/lib/service/jev-keys";
import { completeJevRequest, insertInFlightRequest } from "@/lib/db/repos/jev-requests";
import { claimSystemAlertDelivery, dispatchSystemAlerts, finishSystemAlertDelivery, insertSystemAlert, listRecentSystemAlerts } from "@/lib/db/repos/system-alerts";
import { classifyAlertError, formatSystemAlert } from "@/lib/system-alerts/format";
import { saveNotifyConfig } from "@/lib/service/config";
import { runSystemAlertDelivererOnce } from "@/lib/worker/system-alert-deliverer";
import { sendBark } from "@/lib/notify/bark";
import { sendFeishu } from "@/lib/notify/feishu";

const KEY = testKey();
const NOW = new Date("2026-10-27T00:00:00Z");
type Db = ReturnType<typeof createTestDb>["db"];
function seed(db: Db, generation = 1) {
  insertSystemAlert(db, { keyId: "synthetic", keyGeneration: generation, keyLabel: "部署验收", channelName: "部署验收", consecutiveFailures: 10, occurredAt: NOW.toISOString(), httpStatus: null, errorCategory: "network" });
}
function reserve(db: Db, key: { id: string; label: string; generation: number }) {
  return insertInFlightRequest(db, { keyId: key.id, keyLabel: key.label, keyGeneration: key.generation, purpose: "test", requestedModel: "jev-latest", providerOrigin: null, configVersion: 1, startedAt: NOW, leaseUntil: new Date(NOW.getTime() + 60000) });
}
function fail(db: Db, id: string) {
  return completeJevRequest(db, { id, now: NOW, status: "failed", httpStatus: 401, errorCode: "auth", errorMessage: "不进入告警的原始响应 sk-secret" });
}

describe("密钥自动停用系统告警", () => {
  it("显示名内的不可见字符不能绕过URL和凭据遮盖，存储与通知正文均脱敏", () => {
    const ctx = createTestDb();
    try {
      insertSystemAlert(ctx.db, {
        keyId: "synthetic", keyGeneration: 1,
        channelName: "模型 https:\u200b//private.example/path",
        keyLabel: "sk-\u200bprivate-token Bearer\tshort-token",
        consecutiveFailures: 10, occurredAt: NOW.toISOString(), httpStatus: null, errorCategory: "network",
      });
      const alert = listRecentSystemAlerts(ctx.db)[0];
      const output = JSON.stringify({ alert, message: formatSystemAlert(alert) });
      for (const secret of ["private.example", "private-token", "short-token"]) expect(output).not.toContain(secret);
      expect(alert.channelName).toContain("[地址已隐藏]");
      expect(alert.keyLabel).toContain("[凭据已隐藏]");
    } finally { ctx.close(); }
  });

  it("9→10事务内生成一次，重复/迟到结果不重复；恢复后新generation可再次告警，删除后保留", () => {
    const ctx = createTestDb();
    try {
      const key = addJevKey(ctx.db, { label: "密钥 sk-private\nhttps://secret.example/a", apiKey: "sk-real-secret" }, KEY);
      const late = reserve(ctx.db, key);
      for (let i = 0; i < 9; i++) fail(ctx.db, reserve(ctx.db, key).id);
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(0);
      const tenth = reserve(ctx.db, key);
      expect(fail(ctx.db, tenth.id).keyDisabled).toBe(true);
      expect(fail(ctx.db, tenth.id).recorded).toBe(false);
      fail(ctx.db, reserve(ctx.db, key).id);
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(1);
      const restored = updateJevKeySettings(ctx.db, key.id, { enabled: true }, KEY);
      fail(ctx.db, late.id);
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(1);
      for (let i = 0; i < 10; i++) fail(ctx.db, reserve(ctx.db, restored!).id);
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(2);
      removeJevKey(ctx.db, key.id);
      expect(listRecentSystemAlerts(ctx.db)).toHaveLength(2);
      const safe = JSON.stringify(listRecentSystemAlerts(ctx.db));
      for (const secret of ["sk-private", "sk-real-secret", "secret.example", "原始响应"]) expect(safe).not.toContain(secret);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    } finally { ctx.close(); }
  });

  it("无模型密钥也发送；重开数据库继续，只重试失败渠道；不保存原始response/error", async () => {
    const ctx = createTestDb();
    let reopened: Database.Database | undefined;
    try {
      seed(ctx.db);
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "device-secret" }, feishu: { enabled: true, webhook: "https://open.feishu.cn/hook/secret" } }, KEY);
      let time = NOW;
      let feishuCalls = 0;
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes("feishu")) {
          feishuCalls++;
          return new Response(JSON.stringify({ code: feishuCalls === 1 ? 11232 : 0, msg: "secret-response" }));
        }
        return new Response(JSON.stringify({ code: 200, message: "secret-response" }));
      });
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => time, fetchImpl });
      expect(listRecentSystemAlerts(ctx.db)[0].deliveries.map((d) => d.status)).toEqual(["succeeded", "failed"]);
      reopened = new Database(ctx.dbPath);
      time = new Date(NOW.getTime() + 10000);
      await runSystemAlertDelivererOnce(reopened, { key: KEY, now: () => time, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(listRecentSystemAlerts(ctx.db)[0].deliveries.every((d) => d.status === "succeeded")).toBe(true);
      expect(JSON.stringify(listRecentSystemAlerts(ctx.db))).not.toContain("secret-response");
    } finally { reopened?.close(); ctx.close(); }
  });

  it("无渠道为终态，后来启用不补发；已分派的关闭渠道停止重试", async () => {
    const ctx = createTestDb();
    try {
      seed(ctx.db);
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW });
      expect(listRecentSystemAlerts(ctx.db)[0].dispatchStatus).toBe("no_channels");
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "device-secret" } }, KEY);
      const fetchImpl = vi.fn(async () => new Response('{"code":200}'));
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW, fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      seed(ctx.db, 2);
      dispatchSystemAlerts(ctx.db, ["bark"], NOW);
      saveNotifyConfig(ctx.db, { bark: { enabled: false } }, KEY);
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW, fetchImpl });
      expect(listRecentSystemAlerts(ctx.db).find((a) => a.keyGeneration === 2)?.deliveries[0].status).toBe("disabled");
    } finally { ctx.close(); }
  });

  it.each([401, 429])("HTTP %i 即使返回非JSON，也按认证/限流状态决定重试", async (status) => {
    const ctx = createTestDb();
    try {
      seed(ctx.db);
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "device" } }, KEY);
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW,
        fetchImpl: async () => new Response("不可解析响应", { status }) });
      expect(listRecentSystemAlerts(ctx.db)[0].deliveries[0].status).toBe(status === 401 ? "disabled" : "failed");
    } finally { ctx.close(); }
  });

  it("租约token隔离迟到写；第五次发送崩溃回收为dead", () => {
    const ctx = createTestDb();
    try {
      seed(ctx.db); dispatchSystemAlerts(ctx.db, ["bark"], NOW);
      const first = claimSystemAlertDelivery(ctx.db, NOW)!;
      expect(claimSystemAlertDelivery(ctx.db, NOW)).toBeNull();
      expect(finishSystemAlertDelivery(ctx.db, first, "succeeded", new Date(NOW.getTime() + 60000))).toBe(false);
      const secondTime = new Date(NOW.getTime() + 60001);
      const second = claimSystemAlertDelivery(ctx.db, secondTime)!;
      expect(second.leaseToken).not.toBe(first.leaseToken);
      expect(finishSystemAlertDelivery(ctx.db, first, "succeeded", secondTime)).toBe(false);
      for (let n = 2; n < 5; n++) claimSystemAlertDelivery(ctx.db, new Date(NOW.getTime() + n * 60001));
      expect(claimSystemAlertDelivery(ctx.db, new Date(NOW.getTime() + 5 * 60001))).toBeNull();
      expect(listRecentSystemAlerts(ctx.db)[0].deliveries[0]).toMatchObject({ status: "dead", attempts: 5 });
    } finally { ctx.close(); }
  });

  it("瞬时失败最多五次，永久错误立即停止", async () => {
    const ctx = createTestDb();
    try {
      seed(ctx.db);
      saveNotifyConfig(ctx.db, { bark: { enabled: true, deviceKey: "device" } }, KEY);
      const fetchImpl = vi.fn(async () => new Response('{"code":500}', { status: 503 }));
      for (let n = 0; n < 7; n++) await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => new Date(NOW.getTime() + n * 300000), fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(listRecentSystemAlerts(ctx.db)[0].deliveries[0].status).toBe("dead");
      seed(ctx.db, 2);
      await runSystemAlertDelivererOnce(ctx.db, { key: KEY, now: () => NOW, fetchImpl: async () => new Response('{"code":400}') });
      expect(listRecentSystemAlerts(ctx.db).find((a) => a.keyGeneration === 2)?.deliveries[0].status).toBe("disabled");
    } finally { ctx.close(); }
  });
});

it("安全分类及文案区分认证与网络，渠道消息不伪装线报且日志不泄露异常", async () => {
  expect([401,403,429,529,503,200].map((status) => classifyAlertError(status, null))).toEqual(["auth","auth","rate_limit","rate_limit","upstream","invalid_response"]);
  expect(classifyAlertError(null, null)).toBe("unknown");
  expect(classifyAlertError(null, "network")).toBe("network");
  const base = { channelName: "模型", keyLabel: "密钥", consecutiveFailures: 10, occurredAt: NOW.toISOString(), httpStatus: null };
  const message = formatSystemAlert({ ...base, errorCategory: "network" });
  expect(message.lines.join("\n")).toContain("代理");
  expect(message.lines.join("\n")).not.toContain("凭据");
  expect(formatSystemAlert({ ...base, errorCategory: "auth" }).lines.join("\n")).toContain("凭据");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const fetchImpl = vi.fn(async () => { throw new Error("https://secret-webhook device-secret Authorization"); });
    await sendBark(message, { serverUrl: "https://api.day.app", deviceKey: "device-secret" }, { fetchImpl });
    await sendFeishu(message, { webhookUrl: "https://secret-webhook" }, { fetchImpl });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const payload = JSON.parse(String(calls[0][1].body));
    expect(payload.title).toBe("模型密钥已自动停用");
    expect(payload.group).toBe("系统故障告警");
    expect(payload.url).toBeUndefined();
  } finally { log.mockRestore(); }
});
