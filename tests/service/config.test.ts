import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { setSetting } from "@/lib/db/repos/settings";
import {
  getChannelSelection,
  getJevConfigView,
  getJevRuntimeConfig,
  getNotifyConfigView,
  getNotifyRuntimeConfig,
  saveChannelSelection,
  saveJevConfig,
  saveNotifyConfig,
  MAX_JE_CONCURRENCY,
  MIN_JOBS_PER_ROUND,
} from "@/lib/service/config";
import { createTestDb, testKey } from "../helpers/db";
import { HttpError } from "@/lib/http/json";

const KEY = testKey();

describe("配置与凭据三态语义（AC1/AC2）", () => {
  it("Jev 配置：空串保留、字符串替换、explicit clear 清除", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-first-secret" }, KEY);
      expect(getJevConfigView(ctx.db, KEY).apiKey.configured).toBe(true);

      // 空串不是清除指令
      const afterEmpty = saveJevConfig(ctx.db, { apiKey: "" }, KEY);
      expect(afterEmpty.apiKey.configured).toBe(true);
      expect(getJevRuntimeConfig(ctx.db, KEY)?.apiKey).toBe("sk-first-secret");

      // 未提供字段保留旧值
      saveJevConfig(ctx.db, { model: "jev-v2" }, KEY);
      expect(getJevRuntimeConfig(ctx.db, KEY)?.apiKey).toBe("sk-first-secret");
      expect(getJevConfigView(ctx.db, KEY).config.model).toBe("jev-v2");

      // 显式清除
      saveJevConfig(ctx.db, { apiKey: { clear: true } }, KEY);
      expect(getJevConfigView(ctx.db, KEY).apiKey.configured).toBe(false);
      expect(getJevRuntimeConfig(ctx.db, KEY)).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("读取配置只返回掩码，绝不回传明文", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-abcdef123456" }, KEY);
      const view = getJevConfigView(ctx.db, KEY);
      expect(JSON.stringify(view)).not.toContain("sk-abcdef123456");
      expect(view.apiKey.masked).toBe("****3456");
    } finally {
      ctx.close();
    }
  });

  it("推送渠道配置：独立启停与凭据状态", () => {
    const ctx = createTestDb();
    try {
      saveNotifyConfig(
        ctx.db,
        {
          bark: { enabled: true, deviceKey: "bark-device-key" },
          feishu: { enabled: false, webhook: "https://open.feishu.cn/hook" },
        },
        KEY,
      );
      const view = getNotifyConfigView(ctx.db, KEY);
      expect(view.config.bark.enabled).toBe(true);
      expect(view.config.feishu.enabled).toBe(false);
      expect(view.bark.deviceKey.configured).toBe(true);
      expect(view.feishu.webhook.configured).toBe(true);
      expect(JSON.stringify(view)).not.toContain("bark-device-key");

      const runtime = getNotifyRuntimeConfig(ctx.db, KEY);
      expect(runtime.bark?.deviceKey).toBe("bark-device-key");
      // 未启用的渠道不进入运行时配置
      expect(runtime.feishu).toBeNull();
      expect(runtime.enabledChannels).toEqual(["bark"]);
    } finally {
      ctx.close();
    }
  });

  it("频道选择默认 all，可保存 custom 并持久化", () => {
    const ctx = createTestDb();
    try {
      expect(getChannelSelection(ctx.db).mode).toBe("all");
      saveChannelSelection(ctx.db, { mode: "custom", customIds: ["haodan"] });
      expect(getChannelSelection(ctx.db)).toEqual({
        mode: "custom",
        customIds: ["haodan"],
      });
    } finally {
      ctx.close();
    }
  });

  it("加密密钥变更后凭据标记为不可读，而不是抛异常", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { apiKey: "sk-rotate-me" }, testKey(1));
      const view = getJevConfigView(ctx.db, testKey(2));
      expect(view.apiKey.configured).toBe(true);
      expect(view.apiKey.unreadable).toBe(true);
      expect(view.apiKey.masked).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it("重启用同一加密密钥可以解密凭据", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xianbao-reopen-"));
    const dbPath = path.join(dir, "test.db");
    try {
      const first = getDb(dbPath);
      migrate(first);
      saveJevConfig(first, { apiKey: "sk-persist-check" }, KEY);
      saveNotifyConfig(
        first,
        { bark: { enabled: true, deviceKey: "device-persist" } },
        KEY,
      );
      closeDb();

      const second = getDb(dbPath);
      migrate(second);
      expect(getJevRuntimeConfig(second, KEY)?.apiKey).toBe("sk-persist-check");
      expect(getNotifyRuntimeConfig(second, KEY).bark?.deviceKey).toBe("device-persist");
      closeDb();
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Jev 并发与每轮任务数的配置契约", () => {
  it("默认为串行 1 与每轮 3 个任务", () => {
    const ctx = createTestDb();
    try {
      const config = getJevConfigView(ctx.db, KEY).config;
      expect(config.concurrency).toBe(1);
      expect(config.jobsPerRound).toBe(3);
    } finally {
      ctx.close();
    }
  });

  it("保存后可读回", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 4, jobsPerRound: 12 }, KEY);
      const config = getJevConfigView(ctx.db, KEY).config;
      expect(config.concurrency).toBe(4);
      expect(config.jobsPerRound).toBe(12);
    } finally {
      ctx.close();
    }
  });

  it("越界值写入时被收敛到边界，非法值回退到旧值", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 99, jobsPerRound: 0 }, KEY);
      let config = getJevConfigView(ctx.db, KEY).config;
      expect(config.concurrency).toBe(MAX_JE_CONCURRENCY);
      expect(config.jobsPerRound).toBe(MIN_JOBS_PER_ROUND);

      // 非数字（例如手工写入脏数据）时读取回退到默认，不抛异常
      setSetting(ctx.db, "jev", { concurrency: "many", jobsPerRound: null });
      config = getJevConfigView(ctx.db, KEY).config;
      expect(config.concurrency).toBe(1);
      expect(config.jobsPerRound).toBe(3);
    } finally {
      ctx.close();
    }
  });

  it("未启用配置改动时保留旧值", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { concurrency: 2, jobsPerRound: 5 }, KEY);
      saveJevConfig(ctx.db, { model: "jev-v2" }, KEY);
      const config = getJevConfigView(ctx.db, KEY).config;
      expect(config.model).toBe("jev-v2");
      expect(config.concurrency).toBe(2);
      expect(config.jobsPerRound).toBe(5);
    } finally {
      ctx.close();
    }
  });
});

describe("三模式配置与全局正则（AC2/AC7/AC8）", () => {
  it("新库默认逐条模式、空规则，不因升级自动启用预筛", () => {
    const ctx = createTestDb();
    try {
      const config = getJevConfigView(ctx.db, KEY).config;
      expect(config.evaluationMode).toBe("individual");
      expect(config.regexRules).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("保存模式与规则后可读回；部分更新保留旧模式", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(
        ctx.db,
        { evaluationMode: "regex_gate", regexRules: ["抽纸|软抽", "湿巾"] },
        KEY,
      );
      let config = getJevConfigView(ctx.db, KEY).config;
      expect(config.evaluationMode).toBe("regex_gate");
      expect(config.regexRules).toEqual(["抽纸|软抽", "湿巾"]);

      // 只改连接配置不应重置模式或规则。
      saveJevConfig(ctx.db, { model: "jev-v9" }, KEY);
      config = getJevConfigView(ctx.db, KEY).config;
      expect(config.evaluationMode).toBe("regex_gate");
      expect(config.regexRules).toEqual(["抽纸|软抽", "湿巾"]);
    } finally {
      ctx.close();
    }
  });

  it("显式空数组清空规则，但正则模式不允许空规则", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { regexRules: ["抽纸"] }, KEY);
      expect(getJevConfigView(ctx.db, KEY).config.regexRules).toEqual(["抽纸"]);

      saveJevConfig(ctx.db, { regexRules: [] }, KEY);
      expect(getJevConfigView(ctx.db, KEY).config.regexRules).toEqual([]);

      expect(() =>
        saveJevConfig(ctx.db, { evaluationMode: "regex_gate" }, KEY),
      ).toThrowError(/正则预筛模式至少需要一条合法的正则规则/);
    } finally {
      ctx.close();
    }
  });

  it("规则归一化：忽略空白行、保留空格、去重（AC7）", () => {
    const ctx = createTestDb();
    try {
      const view = saveJevConfig(
        ctx.db,
        {
          evaluationMode: "regex_gate",
          regexRules: ["  抽纸 | 软抽 ", "", "   ", "  抽纸 | 软抽 ", "湿巾"],
        },
        KEY,
      );
      expect(view.config.regexRules).toEqual(["  抽纸 | 软抽 ", "湿巾"]);
    } finally {
      ctx.close();
    }
  });

  it("非法规则被拒绝且不覆盖旧配置（AC8）", () => {
    const ctx = createTestDb();
    try {
      saveJevConfig(ctx.db, { regexRules: ["抽纸"] }, KEY);
      expect(() =>
        saveJevConfig(ctx.db, { regexRules: ["a".repeat(501)] }, KEY),
      ).toThrowError(/500 个字符/);
      expect(getJevConfigView(ctx.db, KEY).config.regexRules).toEqual(["抽纸"]);

      expect(() =>
        saveJevConfig(
          ctx.db,
          { regexRules: Array.from({ length: 21 }, (_, index) => `a${index}`) },
          KEY,
        ),
      ).toThrowError(/最多 20 条/);
      expect(getJevConfigView(ctx.db, KEY).config.regexRules).toEqual(["抽纸"]);
    } finally {
      ctx.close();
    }
  });

  it("并发修改时版本冲突拒绝写入（409 语义）", () => {
    const ctx = createTestDb();
    try {
      const first = saveJevConfig(ctx.db, { model: "jev-v1" }, KEY);
      // 另一个会话先写了一次，版本自增。
      saveJevConfig(ctx.db, { model: "jev-v2" }, KEY);

      let thrown: unknown;
      try {
        saveJevConfig(
          ctx.db,
          { model: "jev-v3", expectedVersion: first.version },
          KEY,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(409);
      // 旧校验不得应用到新规则：模式/规则保持另一个会话的写入结果。
      expect(getJevConfigView(ctx.db, KEY).config.model).toBe("jev-v2");
    } finally {
      ctx.close();
    }
  });
});
