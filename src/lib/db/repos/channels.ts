import type Database from "better-sqlite3";
import type {
  ChannelOrigin,
  ChannelSelectionMode,
  ChannelState,
} from "@/lib/domain/types";
import { getSetting, setSetting } from "@/lib/db/repos/settings";

/**
 * 采集频道仓库。
 *
 * `id` 使用稳定来源标识（feed 用分类别名，zdm 用 `zdm`），不随 meta 返回顺序变化。
 * `origin` 区分普通分类流与值得买独立流；两套适配器与编号空间互不混用。
 */

const CHANNELS_SETTING_NAMESPACE = "channels";

interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  alias: string | null;
  origin: string;
  available: number;
  selected: number;
  initialized: number;
  cache_ttl_seconds: number;
  next_poll_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toChannel(row: ChannelRow): ChannelState {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    alias: row.alias,
    origin: row.origin as ChannelOrigin,
    available: row.available === 1,
    selected: row.selected === 1,
    initialized: row.initialized === 1,
    cacheTtlSeconds: row.cache_ttl_seconds,
    nextPollAt: row.next_poll_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ChannelCatalogEntry {
  id: string;
  name: string;
  alias: string | null;
  origin: ChannelOrigin;
}

export interface ChannelSelection {
  mode: ChannelSelectionMode;
  customIds: string[];
}

export const DEFAULT_CHANNEL_SELECTION: ChannelSelection = {
  mode: "all",
  customIds: [],
};

export function getChannelSelection(db: Database.Database): ChannelSelection {
  const record = getSetting<ChannelSelection>(db, CHANNELS_SETTING_NAMESPACE);
  if (!record) return { ...DEFAULT_CHANNEL_SELECTION };
  const mode = record.value?.mode === "custom" ? "custom" : "all";
  const customIds = Array.isArray(record.value?.customIds)
    ? record.value.customIds.filter((id): id is string => typeof id === "string")
    : [];
  return { mode, customIds };
}

/** 保存选择模式；`all` 跟随能力清单，`custom` 只启用显式列出的频道。 */
export function saveChannelSelection(
  db: Database.Database,
  selection: ChannelSelection,
): number {
  return setSetting(db, CHANNELS_SETTING_NAMESPACE, selection);
}

/**
 * 同步 meta 能力清单到 `channels` 表并应用当前选择。
 *
 * - 新频道插入，已存在频道只更新名称/别名/可用性；
 * - meta 中消失的频道置 `available = 0`（停止请求，但不删除已存线报）；
 * - `initialized`、`last_error`、`next_poll_at` 等运行状态不受同步影响。
 */
export function syncChannelsFromCatalog(
  db: Database.Database,
  entries: ChannelCatalogEntry[],
  selection: ChannelSelection = getChannelSelection(db),
): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO channels (
       id, name, kind, alias, origin, available, selected, initialized,
       cache_ttl_seconds, next_poll_at, created_at, updated_at
     ) VALUES (
       @id, @name, @kind, @alias, @origin, 1, @selected, 0,
       10, NULL, @now, @now
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       alias = excluded.alias,
       origin = excluded.origin,
       available = 1,
       selected = @selected,
       updated_at = @now`,
  );
  const disable = db.prepare(
    "UPDATE channels SET available = 0, selected = 0, updated_at = ? WHERE id = ?",
  );

  const run = db.transaction(() => {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      upsert.run({
        id: entry.id,
        name: entry.name,
        kind: entry.origin,
        alias: entry.alias,
        origin: entry.origin,
        selected: selection.mode === "all" || selection.customIds.includes(entry.id) ? 1 : 0,
        now,
      });
    }
    const existing = db.prepare("SELECT id FROM channels").all() as Array<{
      id: string;
    }>;
    for (const row of existing) {
      if (!seen.has(row.id)) disable.run(now, row.id);
    }
  });
  run();
}

/** 重新应用选择模式（不依赖 meta）。 */
export function applyChannelSelection(
  db: Database.Database,
  selection: ChannelSelection,
): void {
  const now = new Date().toISOString();
  if (selection.mode === "all") {
    db.prepare(
      "UPDATE channels SET selected = 1, updated_at = ? WHERE available = 1",
    ).run(now);
    return;
  }
  const setSelected = db.prepare(
    "UPDATE channels SET selected = ?, updated_at = ? WHERE id = ?",
  );
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT id, available FROM channels").all() as Array<{
      id: string;
      available: number;
    }>;
    for (const row of rows) {
      const selected =
        row.available === 1 && selection.customIds.includes(row.id) ? 1 : 0;
      setSelected.run(selected, now, row.id);
    }
  });
  run();
}

export function listChannels(db: Database.Database): ChannelState[] {
  const rows = db
    .prepare("SELECT * FROM channels ORDER BY origin ASC, name ASC")
    .all() as ChannelRow[];
  return rows.map(toChannel);
}

/**
 * 服务端分页读取采集频道。
 *
 * 排序追加唯一键 `id`，否则 `origin`/`name` 并列时翻页可能重复/漏项；
 * `items` 与 `total` 在同一个只读事务内读取，保证两者一致。
 * 只影响展示；`listChannels` / `listDueChannels` 及 worker 调用点不变。
 */
export function listChannelsPage(
  db: Database.Database,
  query: { limit: number; offset: number },
): { items: ChannelState[]; total: number } {
  const read = db.transaction(() => {
    const total = db.prepare("SELECT COUNT(*) AS count FROM channels").get() as {
      count: number;
    };
    const rows = db
      .prepare(
        "SELECT * FROM channels ORDER BY origin ASC, name ASC, id ASC LIMIT ? OFFSET ?",
      )
      .all(query.limit, query.offset) as ChannelRow[];
    return { items: rows.map(toChannel), total: total.count };
  });
  return read();
}

export function getChannel(
  db: Database.Database,
  id: string,
): ChannelState | null {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
    | ChannelRow
    | undefined;
  return row ? toChannel(row) : null;
}

/** 到期待采集频道（可用 + 已选 + next_poll_at 为空或已到）。 */
export function listDueChannels(
  db: Database.Database,
  nowIso: string,
  limit = 10,
): ChannelState[] {
  const rows = db
    .prepare(
      `SELECT * FROM channels
       WHERE available = 1 AND selected = 1
         AND (next_poll_at IS NULL OR next_poll_at <= ?)
       ORDER BY next_poll_at IS NULL DESC, next_poll_at ASC
       LIMIT ?`,
    )
    .all(nowIso, limit) as ChannelRow[];
  return rows.map(toChannel);
}

/**
 * 原子占用一个频道的本轮轮询：仅当仍未到期时把 `next_poll_at` 推进。
 * 返回 false 表示已被其它进程/并发轮次占用，避免 web 与 worker 重复采集。
 */
export function tryClaimChannelPoll(
  db: Database.Database,
  id: string,
  nowIso: string,
  nextPollAtIso: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE channels
       SET next_poll_at = @nextPollAt, updated_at = @now
       WHERE id = @id AND available = 1 AND selected = 1
         AND (next_poll_at IS NULL OR next_poll_at <= @now)`,
    )
    .run({ id, now: nowIso, nextPollAt: nextPollAtIso });
  return result.changes === 1;
}

export function markChannelSuccess(
  db: Database.Database,
  id: string,
  input: {
    nextPollAt: string;
    lastSuccessAt: string;
    cacheTtlSeconds?: number;
  },
): void {
  db.prepare(
    `UPDATE channels SET next_poll_at = @nextPollAt, last_success_at = @lastSuccessAt,
       last_error = NULL, updated_at = @lastSuccessAt,
       cache_ttl_seconds = COALESCE(@cacheTtlSeconds, cache_ttl_seconds)
     WHERE id = @id`,
  ).run({
    id,
    nextPollAt: input.nextPollAt,
    lastSuccessAt: input.lastSuccessAt,
    cacheTtlSeconds: input.cacheTtlSeconds ?? null,
  });
}

export function markChannelError(
  db: Database.Database,
  id: string,
  input: { error: string; lastErrorAt: string; nextPollAt: string },
): void {
  db.prepare(
    `UPDATE channels SET last_error = @error, last_error_at = @lastErrorAt,
       next_poll_at = @nextPollAt, updated_at = @lastErrorAt
     WHERE id = @id`,
  ).run({ id, ...input });
}

export function setChannelInitialized(
  db: Database.Database,
  id: string,
  initialized: boolean,
): void {
  db.prepare(
    "UPDATE channels SET initialized = ?, updated_at = ? WHERE id = ?",
  ).run(initialized ? 1 : 0, new Date().toISOString(), id);
}

export function setChannelSelectedFlag(
  db: Database.Database,
  id: string,
  selected: boolean,
): void {
  db.prepare("UPDATE channels SET selected = ?, updated_at = ? WHERE id = ?").run(
    selected ? 1 : 0,
    new Date().toISOString(),
    id,
  );
}

export function setChannelAvailability(
  db: Database.Database,
  id: string,
  available: boolean,
): void {
  db.prepare(
    "UPDATE channels SET available = ?, updated_at = ? WHERE id = ?",
  ).run(available ? 1 : 0, new Date().toISOString(), id);
}

export interface ChannelStats {
  total: number;
  selected: number;
  initialized: number;
  failing: number;
}

export function channelStats(db: Database.Database): ChannelStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN selected = 1 AND available = 1 THEN 1 ELSE 0 END) AS selected,
         SUM(CASE WHEN initialized = 1 AND selected = 1 THEN 1 ELSE 0 END) AS initialized,
         SUM(CASE WHEN last_error IS NOT NULL AND selected = 1 THEN 1 ELSE 0 END) AS failing
       FROM channels`,
    )
    .get() as { total: number; selected: number | null; initialized: number | null; failing: number | null };
  return {
    total: row.total ?? 0,
    selected: row.selected ?? 0,
    initialized: row.initialized ?? 0,
    failing: row.failing ?? 0,
  };
}
