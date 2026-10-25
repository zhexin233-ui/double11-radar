import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import {
  createNeedGroup,
  deleteNeedGroup,
  getNeedGroup,
  listNeedGroups,
  updateNeedGroup,
} from "@/lib/db/repos/need-groups";
import {
  createNeed,
  getNeed,
  listEnabledNeeds,
  listNeedsByGroup,
  listNeedsPage,
  updateNeed,
} from "@/lib/db/repos/needs";

describe("db/repos/need-groups", () => {
  it("支持分组增删改查与默认字段", () => {
    const ctx = createTestDb();
    try {
      // 默认存在 'default' 分组（由 migration V5 插入）
      const initialGroups = listNeedGroups(ctx.db);
      expect(initialGroups.some((g) => g.id === "default")).toBe(true);

      // 创建新分组
      const group = createNeedGroup(ctx.db, {
        name: "食品饮料",
        enabled: true,
        orderNum: 1,
      });
      expect(group.id).toBeTruthy();
      expect(group.name).toBe("食品饮料");
      expect(group.enabled).toBe(true);
      expect(group.orderNum).toBe(1);

      // 获取单个分组
      const fetched = getNeedGroup(ctx.db, group.id);
      expect(fetched?.name).toBe("食品饮料");

      // 更新分组
      const updated = updateNeedGroup(ctx.db, group.id, {
        name: "食品生鲜",
        enabled: false,
        orderNum: 2,
      });
      expect(updated?.name).toBe("食品生鲜");
      expect(updated?.enabled).toBe(false);
      expect(updated?.orderNum).toBe(2);

      // 再次查询
      const groups = listNeedGroups(ctx.db);
      expect(groups.find((g) => g.id === group.id)?.name).toBe("食品生鲜");
    } finally {
      ctx.close();
    }
  });

  it("双层判定：只有组启用且项启用的需求才出现在 listEnabledNeeds", () => {
    const ctx = createTestDb();
    try {
      const groupA = createNeedGroup(ctx.db, { name: "数码电子", enabled: true });
      const groupB = createNeedGroup(ctx.db, { name: "服装美妆", enabled: false });

      // groupA 下加一个启用、一个关闭
      const needA1 = createNeed(ctx.db, {
        groupId: groupA.id,
        name: "iPhone",
        enabled: true,
      });
      const needA2 = createNeed(ctx.db, {
        groupId: groupA.id,
        name: "iPad",
        enabled: false,
      });

      // groupB 下加一个启用
      const needB1 = createNeed(ctx.db, {
        groupId: groupB.id,
        name: "运动鞋",
        enabled: true,
      });

      const enabled = listEnabledNeeds(ctx.db);
      const enabledIds = enabled.map((n) => n.id);

      // 只有 needA1 符合 (组A开启 + 自身开启)
      expect(enabledIds).toContain(needA1.id);
      expect(enabledIds).not.toContain(needA2.id);
      expect(enabledIds).not.toContain(needB1.id);

      // 当开启 groupB 时，needB1 自动生效
      updateNeedGroup(ctx.db, groupB.id, { enabled: true });
      const enabledAfter = listEnabledNeeds(ctx.db);
      expect(enabledAfter.map((n) => n.id)).toContain(needB1.id);
    } finally {
      ctx.close();
    }
  });

  it("级联删除分组时自动清理该组内所有需求", () => {
    const ctx = createTestDb();
    try {
      const group = createNeedGroup(ctx.db, { name: "待删除组", enabled: true });
      const need1 = createNeed(ctx.db, {
        groupId: group.id,
        name: "项目1",
      });
      const need2 = createNeed(ctx.db, {
        groupId: group.id,
        name: "项目2",
      });

      expect(listNeedsByGroup(ctx.db, group.id)).toHaveLength(2);

      const deleted = deleteNeedGroup(ctx.db, group.id);
      expect(deleted).toBe(true);

      expect(getNeedGroup(ctx.db, group.id)).toBeNull();
      expect(getNeed(ctx.db, need1.id)).toBeNull();
      expect(getNeed(ctx.db, need2.id)).toBeNull();
      expect(listNeedsByGroup(ctx.db, group.id)).toHaveLength(0);
    } finally {
      ctx.close();
    }
  });
});
