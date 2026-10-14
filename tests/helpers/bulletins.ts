import type { Bulletin, NormalizedBulletin } from "@/lib/domain/types";

/** 构造测试用线报。 */
export function makeNormalized(
  overrides: Partial<NormalizedBulletin> = {},
): NormalizedBulletin {
  return {
    source: "xianbao",
    sourceNs: "feed:haodan",
    sourceId: "1",
    url: "https://example.test/1.html",
    title: "心相印超韧抽纸 24包",
    content: "9.9元包邮",
    category: "好单线报-日用-天猫",
    price: 9.9,
    brand: null,
    mall: null,
    publishedAt: "2026-10-14T00:42:00.000Z",
    payload: "{}",
    contentVersion: "deadbeefdeadbeef",
    ...overrides,
  };
}

/** 构造测试用持久化线报。 */
export function makeBulletin(overrides: Partial<Bulletin> = {}): Bulletin {
  return {
    id: "bulletin-1",
    source: "xianbao",
    sourceNs: "feed:haodan",
    sourceId: "1",
    url: "https://example.test/1.html",
    title: "心相印超韧抽纸 24包",
    content: "9.9元包邮",
    category: "好单线报-日用-天猫",
    price: 9.9,
    brand: null,
    mall: null,
    publishedAt: "2026-10-14T00:42:00.000Z",
    payload: "{}",
    contentVersion: "deadbeefdeadbeef",
    baseline: false,
    createdAt: "2026-10-14T00:42:00.000Z",
    ...overrides,
  };
}
