import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db/migrate";
import { migrations } from "@/lib/db/migrations";
import { getJevKey, reenableDueJevKeys } from "@/lib/db/repos/jev-keys";
import { claimSystemAlertDelivery, finishSystemAlertDelivery } from "@/lib/db/repos/system-alerts";

const NOW = "2026-10-29T00:00:00.000Z";

describe("V8 自动恢复增量迁移", () => {
  it("外键开启时保留全部V7事件、投递ID、重试和有效租约，且存量密钥默认关闭不推断历史", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      migrate(db, migrations.filter((migration) => migration.version <= 7));
      db.prepare(`INSERT INTO jev_api_keys (id,label,secret_namespace,generation,enabled,disabled_reason,consecutive_failures,created_at,updated_at)
        VALUES ('old','历史','old.secret',1,0,'连续10次实际请求失败，已自动禁用',10,?,?)`).run(NOW, NOW);
      const statuses = ["pending", "sending", "failed", "succeeded", "disabled", "dead"];
      for (const [index, status] of statuses.entries()) {
        db.prepare(`INSERT INTO system_alerts
          (id,event_type,key_id,key_generation,channel_name,key_label,consecutive_failures,occurred_at,http_status,error_category,dispatch_status,dispatched_at)
          VALUES (?,'key_auto_disabled','old',?,'渠道','密钥',10,?,429,'rate_limit',?,?)`)
          .run(`event-${index}`, index, NOW, index === 0 ? "pending" : "dispatched", index === 0 ? null : NOW);
        db.prepare(`INSERT INTO system_alert_deliveries
          (id,alert_id,channel,status,attempts,run_at,lease_until,lease_token,http_status,biz_code,last_error,updated_at)
          VALUES (?,?,'bark',?,2,?,?,?,503,'11232','固定错误',?)`)
          .run(`delivery-${index}`, `event-${index}`, status, NOW, "2026-10-29T00:01:00.000Z", "original-token", NOW);
      }
      const events = db.prepare("SELECT * FROM system_alerts ORDER BY id").all();
      const deliveries = db.prepare("SELECT * FROM system_alert_deliveries ORDER BY id").all();
      expect(migrate(db).applied).toEqual([8]);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.prepare("SELECT * FROM system_alerts ORDER BY id").all()).toEqual(events);
      expect(db.prepare("SELECT * FROM system_alert_deliveries ORDER BY id").all()).toEqual(deliveries);
      expect(getJevKey(db, "old")).toMatchObject({ enabled: false, autoReenableEnabled: false,
        autoReenableMinutes: 5, autoDisabledAt: null, autoReenableAt: null });
      db.prepare("UPDATE jev_api_keys SET auto_reenable_enabled = 1 WHERE id = 'old'").run();
      expect(reenableDueJevKeys(db, new Date("2030-01-01"))).toBe(0);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining(["system_alert_dispatch", "system_alert_delivery_due"]));
      expect(() => db.prepare("INSERT INTO system_alert_deliveries (id,alert_id,channel,run_at,updated_at) VALUES ('bad','missing','bark',?,?)").run(NOW, NOW)).toThrow();
      expect(() => db.prepare("UPDATE system_alerts SET error_category = NULL WHERE id = 'event-0'").run()).toThrow();
      expect(() => db.prepare("UPDATE system_alerts SET event_type = 'key_auto_reenabled' WHERE id = 'event-0'").run()).toThrow();
      db.prepare("UPDATE system_alerts SET event_type = 'key_auto_reenabled', error_category = NULL, http_status = NULL WHERE id = 'event-0'").run();
      expect(migrate(db).applied).toEqual([]);
      // 升级前已持有的有效租约仍可完成，失败渠道仍可领取。
      expect(finishSystemAlertDelivery(db, { id: "delivery-1", alertId: "event-1", channel: "bark", status: "sending", attempts: 2,
        leaseToken: "original-token", httpStatus: 503, bizCode: "11232", lastError: "固定错误" }, "succeeded", new Date(NOW))).toBe(true);
      expect(claimSystemAlertDelivery(db, new Date(NOW))).toBeTruthy();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
