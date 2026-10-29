import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testKey } from "../helpers/db";
import { makeNormalized } from "../helpers/bulletins";
import { getBulletin, insertBulletinIfAbsent } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin, upsertEvaluation } from "@/lib/db/repos/evaluations";
import { createNotificationAndDeliveries } from "@/lib/notify/dispatch";
import { listDeliveriesByBulletin, markDeliveryResult, claimDelivery, resetDeliveryForRetry } from "@/lib/db/repos/deliveries";
import { saveNotifyConfig } from "@/lib/service/config";
import { cleanupExpiredBulletins } from "@/lib/service/storage";
import { migrate } from "@/lib/db/migrate";
import { migrations } from "@/lib/db/migrations";
import { syncChannelsFromCatalog, getChannel } from "@/lib/db/repos/channels";

// 使用临时真实 SQLite，所有测试均不发送网络请求。
describe("跨频道通知去重（R3/R4/R5/R6）", () => {
  let ctx: ReturnType<typeof createTestDb>;
  const key = testKey();
  beforeEach(() => {
    ctx = createTestDb();
    saveNotifyConfig(ctx.db, {
      bark: { enabled: true, deviceKey: "test-device" },
      feishu: { enabled: true, webhook: "https://example.test/hook/test" },
    }, key);
  });
  afterEach(() => ctx.close());

  function bulletin(ns: string, sourceId = "shared-1") {
    const { id } = insertBulletinIfAbsent(ctx.db, makeNormalized({ sourceNs: ns, sourceId }), { baseline: false });
    return getBulletin(ctx.db, id)!;
  }
  function notify(ns: string, sourceId = "shared-1", needName = "抽纸") {
    const b = bulletin(ns, sourceId);
    upsertEvaluation(ctx.db, { bulletinId: b.id, needId: needName, needName, needNote: "",
      needVersion: 1, configVersion: 1, ruleVersion: "r", result: "matched" });
    return createNotificationAndDeliveries(ctx.db, b, listEvaluationsByBulletin(ctx.db, b.id), key);
  }

  it("九频道相同原文只安排各渠道一次，后续新需求命中可查而不追加通知", () => {
    const results = Array.from({ length: 9 }, (_, i) => notify(`feed:channel-${i}`, "same", `需求${i}`));
    expect(results[0].channels).toEqual(["bark", "feishu"]);
    expect(results.slice(1).every(r => r.channels.length === 0)).toBe(true);
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM deliveries").get()).toEqual({ c: 2 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM evaluations").get()).toEqual({ c: 9 });
    const firstPayload = JSON.parse(results[0].notification.payload);
    expect(firstPayload.needs).toEqual(["需求0"]);
    expect(listEvaluationsByBulletin(ctx.db, results[8].notification.bulletinId)[0].needName).toBe("需求8");
    expect(notify("feed:channel-0", "same").created).toBe(false);
    expect(notify("feed:other", "different").channels).toHaveLength(2);
    expect(notify("zdm", "same").channels).toHaveLength(2);
    expect(notify("unknown:a", "same").channels).toHaveLength(2);
    expect(notify("unknown:b", "same").channels).toHaveLength(2);
  });

  it("按通知渠道独立防重，关闭渠道不占位", () => {
    saveNotifyConfig(ctx.db, { bark: { enabled: false }, feishu: { enabled: false } }, key);
    expect(notify("feed:off").channels).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM notification_dedup").get()).toEqual({ c: 0 });
    saveNotifyConfig(ctx.db, { bark: { enabled: true } }, key);
    expect(notify("feed:first").channels).toEqual(["bark"]);
    saveNotifyConfig(ctx.db, { feishu: { enabled: true } }, key);
    expect(notify("feed:second").channels).toEqual(["feishu"]);
    expect(notify("feed:third").channels).toEqual([]);
  });

  it("投递插入失败时通知和防重占位整体回滚", () => {
    ctx.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, '模拟投递失败'); END");
    expect(() => notify("feed:first")).toThrow("模拟投递失败");
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM notification_dedup").get()).toEqual({ c: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM notifications").get()).toEqual({ c: 0 });
    ctx.db.exec("DROP TRIGGER reject_delivery");
    expect(notify("feed:second").channels).toHaveLength(2);
  });

  it("失败使用原投递重试，其他频道不会新建替代投递", () => {
    const first = notify("feed:first");
    const d = listDeliveriesByBulletin(ctx.db, first.notification.bulletinId)[0];
    for (const other of listDeliveriesByBulletin(ctx.db, first.notification.bulletinId)) {
      if (other.id !== d.id) markDeliveryResult(ctx.db, { id: other.id, status: "succeeded" });
    }
    markDeliveryResult(ctx.db, { id: d.id, status: "failed", error: "测试失败" });
    expect(notify("feed:second").channels).toEqual([]);
    expect(resetDeliveryForRetry(ctx.db, d.id)).toBe(true);
    expect(claimDelivery(ctx.db, "worker", 60_000)?.id).toBe(d.id);
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM deliveries").get()).toEqual({ c: 2 });
  });

  it("跨连接写竞争被事务串行化，重新连接仍保留防重", () => {
    const second = new Database(ctx.dbPath);
    second.pragma("busy_timeout = 0");
    try {
      const b1 = bulletin("feed:first");
      const b2 = bulletin("feed:second");
      ctx.db.transaction(() => {
        expect(createNotificationAndDeliveries(ctx.db, b1, [], key).channels).toHaveLength(2);
        expect(() => createNotificationAndDeliveries(second, b2, [], key)).toThrow(/locked/);
      }).immediate();
      expect(createNotificationAndDeliveries(second, b2, [], key).channels).toEqual([]);
    } finally { second.close(); }
    const reopened = new Database(ctx.dbPath);
    try {
      const b3 = bulletin("feed:third");
      expect(createNotificationAndDeliveries(reopened, b3, [], key).channels).toEqual([]);
      expect(reopened.prepare("SELECT COUNT(*) AS c FROM deliveries").get()).toEqual({ c: 2 });
    } finally { reopened.close(); }
  });

  it("历史清理保留在途及可重试任务，删除终态历史后仍防重", () => {
    const first = notify("feed:first");
    const bId = first.notification.bulletinId;
    ctx.db.prepare("UPDATE bulletins SET created_at = '2020-01-01T00:00:00.000Z'").run();
    expect(cleanupExpiredBulletins(ctx.db, { retentionDays: 1 }).cleanedBulletins).toBe(0);
    ctx.db.prepare("UPDATE deliveries SET status = 'sending'").run();
    expect(cleanupExpiredBulletins(ctx.db, { retentionDays: 1 }).cleanedBulletins).toBe(0);
    ctx.db.prepare("UPDATE deliveries SET status = 'failed', attempts = 4").run();
    expect(cleanupExpiredBulletins(ctx.db, { retentionDays: 1 }).cleanedBulletins).toBe(0);
    ctx.db.prepare("UPDATE deliveries SET status = 'succeeded'").run();
    expect(cleanupExpiredBulletins(ctx.db, { retentionDays: 1 }).cleanedBulletins).toBe(1);
    expect(getBulletin(ctx.db, bId)).toBeNull();
    expect(notify("feed:second").channels).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM notification_dedup").get()).toEqual({ c: 2 });
  });

  it("清理筛选和删除之间，另一连接不能成功恢复随后被删除的任务", () => {
    const first = notify("feed:first");
    const d = listDeliveriesByBulletin(ctx.db, first.notification.bulletinId)[0];
    ctx.db.prepare("UPDATE deliveries SET status = 'disabled'").run();
    ctx.db.prepare("UPDATE bulletins SET created_at = '2020-01-01T00:00:00.000Z'").run();
    const other = new Database(ctx.dbPath);
    other.pragma("busy_timeout = 0");
    const prepare = ctx.db.prepare.bind(ctx.db);
    let attempted = false;
    let locked = false;
    // 在真实候选查询返回和删除之间，用另一连接模拟网页重试。
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT b.id FROM bulletins b")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          const rows = all(...args);
          if (!attempted) {
            attempted = true;
            try { resetDeliveryForRetry(other, d.id); }
            catch (error) { locked = error instanceof Error && error.message.includes("locked"); }
          }
          return rows;
        });
      }
      return statement;
    });
    try {
      expect(cleanupExpiredBulletins(ctx.db, { retentionDays: 1 }).cleanedBulletins).toBe(1);
      expect(attempted).toBe(true);
      expect(locked).toBe(true);
    } finally { spy.mockRestore(); other.close(); }
  });

  it("V8 升级回填所有真实投递，不把无投递通知当作已安排；频道进度保留", () => {
    // 独立旧库避免用新迁移的台账污染升级样本。
    const old = new Database(":memory:");
    try {
      migrate(old, migrations.filter(m => m.version <= 8));
      old.prepare(`INSERT INTO channels (id,name,kind,alias,origin,available,selected,initialized,
        cache_ttl_seconds,next_poll_at,created_at,updated_at)
        VALUES ('weibo','微博','feed','weibo','feed',1,1,1,10,'2030-01-01','2020','2020')`).run();
      // 跨过 500 条分页边界，同一原文来自不同频道仍只回填一份。
      const statuses = ["succeeded", "pending", "failed", "disabled", "sending"];
      for (let i = 0; i < 505; i++) {
        const status = statuses[i % statuses.length];
        const b = makeNormalized({ sourceNs: `feed:c${i}`, sourceId: i < 5 ? `history-${status}` : "history" });
        const { id } = insertBulletinIfAbsent(old, b, { baseline: false });
        old.prepare("INSERT INTO notifications VALUES (?, ?, '{}', '2020')").run(`n${i}`, id);
        old.prepare(`INSERT INTO deliveries (id,notification_id,bulletin_id,channel,status,created_at,updated_at)
          VALUES (?, ?, ?, 'bark', ?, '2020', '2020')`).run(`d${i}`, `n${i}`, id, status);
      }
      const { id: noDeliveryId } = insertBulletinIfAbsent(old, makeNormalized({ sourceId: "never-sent" }), { baseline: false });
      old.prepare("INSERT INTO notifications VALUES ('no-delivery', ?, '{}', '2020')").run(noDeliveryId);
      expect(migrate(old).applied).toEqual([9]);
      expect(migrate(old).applied).toEqual([]);
      expect(old.prepare("SELECT source, identity_ns, source_id, channel FROM notification_dedup").all())
        .toEqual(expect.arrayContaining(["history", ...statuses.map(status => `history-${status}`)].map(sourceId => ({
          source: "xianbao", identity_ns: "feed", source_id: sourceId, channel: "bark",
        }))));
      expect(old.prepare("SELECT COUNT(*) AS c FROM notification_dedup").get()).toEqual({ c: 6 });
      saveNotifyConfig(old, { bark: { enabled: true, deviceKey: "device" } }, key);
      const existing = insertBulletinIfAbsent(old, makeNormalized({ sourceNs: "feed:new", sourceId: "history" }), { baseline: false });
      expect(createNotificationAndDeliveries(old, getBulletin(old, existing.id)!, [], key).channels).toEqual([]);
      const unsent = insertBulletinIfAbsent(old, makeNormalized({ sourceNs: "feed:new", sourceId: "never-sent" }), { baseline: false });
      expect(createNotificationAndDeliveries(old, getBulletin(old, unsent.id)!, [], key).channels).toEqual(["bark"]);
      syncChannelsFromCatalog(old, [{ id: "weibo", alias: "weibo", name: "微博", origin: "feed", categoryId: 10 }]);
      expect(getChannel(old, "weibo")).toMatchObject({ categoryId: 10, initialized: true, selected: true, nextPollAt: "2030-01-01" });
    } finally { old.close(); }
  });
});
