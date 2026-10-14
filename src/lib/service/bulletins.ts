import type Database from "better-sqlite3";
import { listBulletins, type BulletinListQuery } from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { listDeliveriesByBulletin } from "@/lib/db/repos/deliveries";
import { getNotificationByBulletin } from "@/lib/db/repos/notifications";
import { buildClassificationExplanation } from "@/lib/notify/dispatch";
import type {
  Bulletin,
  Delivery,
  Evaluation,
  Notification,
} from "@/lib/domain/types";

/**
 * 线报列表投影。
 *
 * 页面文案必须区分：匹配 / 待确认（uncertain）/ 处理失败 / 没有匹配 / 建立基线。
 * 说明文字为程序模板，并在 UI 中明确标注为「程序生成的分类说明」。
 */

export type BulletinDisplayStatus =
  | "baseline"
  | "pending"
  | "matched"
  | "failed"
  | "uncertain"
  | "not_matched";

export interface BulletinDetail {
  bulletin: Bulletin;
  status: BulletinDisplayStatus;
  matchedNeeds: string[];
  explanation: string | null;
  evaluations: Evaluation[];
  deliveries: Delivery[];
  notification: Notification | null;
}

export function describeBulletin(
  db: Database.Database,
  bulletin: Bulletin,
): BulletinDetail {
  const evaluations = listEvaluationsByBulletin(db, bulletin.id);
  const deliveries = listDeliveriesByBulletin(db, bulletin.id);
  const notification = getNotificationByBulletin(db, bulletin.id);
  const matchedNeeds = evaluations
    .filter((evaluation) => evaluation.result === "matched")
    .map((evaluation) => evaluation.needName);

  let status: BulletinDisplayStatus;
  if (bulletin.baseline) {
    status = "baseline";
  } else if (matchedNeeds.length > 0) {
    status = "matched";
  } else if (evaluations.some((evaluation) => evaluation.result === "failed")) {
    status = "failed";
  } else if (evaluations.some((evaluation) => evaluation.result === "uncertain")) {
    status = "uncertain";
  } else if (evaluations.length > 0) {
    status = "not_matched";
  } else {
    status = "pending";
  }

  return {
    bulletin,
    status,
    matchedNeeds,
    explanation: matchedNeeds.length
      ? buildClassificationExplanation(matchedNeeds)
      : null,
    evaluations,
    deliveries,
    notification,
  };
}

export function listBulletinDetails(
  db: Database.Database,
  query: BulletinListQuery = {},
): { items: BulletinDetail[]; total: number } {
  const page = listBulletins(db, query);
  return {
    items: page.items.map((bulletin) => describeBulletin(db, bulletin)),
    total: page.total,
  };
}
