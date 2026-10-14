import { channelStats, listChannels } from "@/lib/db/repos/channels";
import { countBulletins } from "@/lib/db/repos/bulletins";
import { countEvaluations } from "@/lib/db/repos/evaluations";
import { jobStats, listRecentFailedJobs } from "@/lib/db/repos/jobs";
import { getRuntimeState } from "@/lib/worker/runtime-state";
import { handleRoute, ok } from "@/lib/http/json";
import { requireAuth } from "@/lib/http/server";
import type Database from "better-sqlite3";

interface StatusCounts {
  matchedBulletins: number;
  uncertainBulletins: number;
  failedEvaluations: number;
  notificationCount: number;
  delivery: Record<string, number>;
  lastMatchedAt: string | null;
}

function collectCounts(db: Database.Database): StatusCounts {
  const matched = db
    .prepare(
      "SELECT COUNT(DISTINCT bulletin_id) AS c FROM evaluations WHERE result = 'matched'",
    )
    .get() as { c: number };
  const uncertain = db
    .prepare(
      `SELECT COUNT(DISTINCT bulletin_id) AS c FROM evaluations
       WHERE result = 'uncertain'
         AND bulletin_id NOT IN (SELECT bulletin_id FROM evaluations WHERE result = 'matched')`,
    )
    .get() as { c: number };
  const failed = db
    .prepare(
      `SELECT COUNT(DISTINCT bulletin_id) AS c FROM evaluations
       WHERE result = 'failed'
         AND bulletin_id NOT IN (SELECT bulletin_id FROM evaluations WHERE result IN ('matched','uncertain'))`,
    )
    .get() as { c: number };
  const notifications = db
    .prepare("SELECT COUNT(*) AS c FROM notifications")
    .get() as { c: number };
  const lastMatched = db
    .prepare("SELECT MAX(updated_at) AS t FROM evaluations WHERE result = 'matched'")
    .get() as { t: string | null };
  const deliveryRows = db
    .prepare("SELECT status, COUNT(*) AS c FROM deliveries GROUP BY status")
    .all() as Array<{ status: string; c: number }>;

  return {
    matchedBulletins: matched.c,
    uncertainBulletins: uncertain.c,
    failedEvaluations: failed.c,
    notificationCount: notifications.c,
    delivery: Object.fromEntries(deliveryRows.map((row) => [row.status, row.c])),
    lastMatchedAt: lastMatched.t,
  };
}

/**
 * 后台运行状态。
 * `processingHealthy=false` 时页面必须显示处理故障，而不是「没有匹配」。
 */
export const GET = handleRoute(async (req) => {
  const db = requireAuth(req);
  const runtime = getRuntimeState(db);
  const channels = listChannels(db);
  const jobs = jobStats(db);
  const counts = collectCounts(db);

  const heartbeatAt = runtime.lastHeartbeatAt
    ? Date.parse(runtime.lastHeartbeatAt)
    : Number.NaN;
  const heartbeatFresh =
    !Number.isNaN(heartbeatAt) && Date.now() - heartbeatAt < 120_000;

  const failingChannels = channels.filter(
    (channel) => channel.selected && channel.lastError,
  );
  const processingHealthy =
    heartbeatFresh && jobs.dead === 0 && failingChannels.length === 0;

  return ok({
    worker: {
      ...runtime,
      heartbeatFresh,
      running: heartbeatFresh,
    },
    channels: {
      stats: channelStats(db),
      failing: failingChannels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        lastError: channel.lastError,
        lastErrorAt: channel.lastErrorAt,
      })),
    },
    jobs,
    counts,
    processingHealthy,
    recentFailedJobs: listRecentFailedJobs(db, 10).map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      updatedAt: job.updatedAt,
    })),
  });
});
