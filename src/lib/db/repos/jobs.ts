import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobKind, JobStatus } from "@/lib/domain/types";

/**
 * 后台任务队列。
 *
 * - `UNIQUE(payload_key)` + `INSERT OR IGNORE` 保证任务创建幂等；
 * - 领取用事务 + 租约（status=leased, lease_until），崩溃后由
 *   `reclaimExpiredLeases` 归还为 pending；
 * - 失败按指数退避重排，超过 `max_attempts` 置 `dead`。
 */

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  payloadKey: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  payload_key: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  lease_until: string | null;
  lease_owner: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    payloadKey: row.payload_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    leaseUntil: row.lease_until,
    leaseOwner: row.lease_owner,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueJobInput {
  kind: JobKind;
  payloadKey: string;
  payload: unknown;
  runAt?: string;
  maxAttempts?: number;
}

export function enqueueJob(
  db: Database.Database,
  input: EnqueueJobInput,
): { id: string; created: boolean } {
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (
         id, kind, status, payload_key, payload, attempts, max_attempts,
         run_at, created_at, updated_at
       ) VALUES (
         @id, @kind, 'pending', @payloadKey, @payload, 0, @maxAttempts,
         @runAt, @now, @now
       )`,
    )
    .run({
      id,
      kind: input.kind,
      payloadKey: input.payloadKey,
      payload: JSON.stringify(input.payload ?? {}),
      maxAttempts: input.maxAttempts ?? 5,
      runAt: input.runAt ?? now,
      now,
    });
  return { id, created: result.changes === 1 };
}

export function getJob(db: Database.Database, id: string): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
  return row ? toJob(row) : null;
}

/** 领取一条到期任务并加租约；无任务返回 null。可按 kind 过滤。 */
export function claimJob(
  db: Database.Database,
  owner: string,
  leaseMs: number,
  now: Date = new Date(),
  kind?: JobKind,
): Job | null {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const claim = db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM jobs
         WHERE status = 'pending' AND run_at <= @nowIso
           AND (@kind IS NULL OR kind = @kind)
         ORDER BY run_at ASC LIMIT 1`,
      )
      .get({ nowIso, kind: kind ?? null }) as { id: string } | undefined;
    if (!candidate) return null;
    const result = db
      .prepare(
        `UPDATE jobs SET status = 'leased', lease_owner = @owner,
           lease_until = @leaseUntil, updated_at = @nowIso
         WHERE id = @id AND status = 'pending'`,
      )
      .run({ id: candidate.id, owner, leaseUntil, nowIso });
    if (result.changes !== 1) return null;
    return candidate.id;
  });
  const id = claim.immediate();
  return id ? getJob(db, id) : null;
}

export function completeJob(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL,
       last_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

/** 记录失败：未超上限则指数退避重排，超限置 dead。 */
export function failJob(
  db: Database.Database,
  id: string,
  error: string,
  now: Date = new Date(),
): { status: JobStatus; attempts: number; runAt: string } {
  const job = getJob(db, id);
  if (!job) throw new Error(`任务不存在：${id}`);
  const attempts = job.attempts + 1;
  const nowIso = now.toISOString();
  if (attempts >= job.maxAttempts) {
    db.prepare(
      `UPDATE jobs SET status = 'dead', attempts = @attempts, last_error = @error,
         lease_owner = NULL, lease_until = NULL, updated_at = @nowIso
       WHERE id = @id`,
    ).run({ id, attempts, error, nowIso });
    return { status: "dead", attempts, runAt: job.runAt };
  }
  const backoffSeconds = Math.min(2 ** attempts, 300);
  const runAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString();
  db.prepare(
    `UPDATE jobs SET status = 'pending', attempts = @attempts, last_error = @error,
       run_at = @runAt, lease_owner = NULL, lease_until = NULL, updated_at = @nowIso
     WHERE id = @id`,
  ).run({ id, attempts, error, runAt, nowIso });
  return { status: "pending", attempts, runAt };
}

/** 归还超期租约，返回归还数量。 */
export function reclaimExpiredLeases(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL,
         updated_at = @nowIso
       WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until <= @nowIso`,
    )
    .run({ nowIso: now.toISOString() });
  return result.changes;
}

export function listRecentFailedJobs(
  db: Database.Database,
  limit = 20,
): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'dead' OR (last_error IS NOT NULL AND status <> 'succeeded')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as JobRow[];
  return rows.map(toJob);
}

export function jobStats(db: Database.Database): {
  pending: number;
  leased: number;
  dead: number;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
         SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
       FROM jobs`,
    )
    .get() as { pending: number | null; leased: number | null; dead: number | null };
  return {
    pending: row.pending ?? 0,
    leased: row.leased ?? 0,
    dead: row.dead ?? 0,
  };
}
