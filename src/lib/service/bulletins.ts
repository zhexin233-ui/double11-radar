import type Database from "better-sqlite3";
import {
  getBulletin,
  getBulletinDisplayStatus,
  isBulletinFilterStatus,
  listBulletins,
  type BulletinDisplayStatus,
  type BulletinFilterStatus,
  type BulletinListQuery,
} from "@/lib/db/repos/bulletins";
import { listEvaluationsByBulletin } from "@/lib/db/repos/evaluations";
import { listDeliveriesByBulletin } from "@/lib/db/repos/deliveries";
import { getNotificationByBulletin } from "@/lib/db/repos/notifications";
import { buildClassificationExplanation } from "@/lib/notify/dispatch";
import { HttpError } from "@/lib/http/json";
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
 *
 * 状态判定的唯一 owner 是仓库层的 `BULLETIN_DISPLAY_STATUS_SQL`：
 * 列表过滤、聚合与详情都复用它，本层不再保留任何 TS 优先级判断。
 */

export type { BulletinDisplayStatus };
export type { BulletinFilterStatus };

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

  // 状态以数据库判定为准；`??` 仅兜底理论上的缺失行，不重新实现优先级。
  const status =
    getBulletinDisplayStatus(db, bulletin.id) ??
    (bulletin.baseline ? "baseline" : "pending");

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

/**
 * 详情读取：bulletin 行与判断/投递/通知投影必须来自同一个只读快照，
 * 避免另一进程中途完成判断时返回互相矛盾的状态。
 */
export function getBulletinDetail(
  db: Database.Database,
  id: string,
): BulletinDetail | null {
  const read = db.transaction(() => {
    const bulletin = getBulletin(db, id);
    if (!bulletin) return null;
    return describeBulletin(db, bulletin);
  });
  return read();
}

export function listBulletinDetails(
  db: Database.Database,
  query: BulletinListQuery = {},
): { items: BulletinDetail[]; total: number } {
  // count、分页记录与逐条投影在同一同步只读事务内读取，保证 total/items/status 一致。
  const read = db.transaction(() => {
    const page = listBulletins(db, query);
    return {
      items: page.items.map((bulletin) => describeBulletin(db, bulletin)),
      total: page.total,
    };
  });
  return read();
}

/** 列表接口的默认页大小（记录页每页 50 条）。 */
export const BULLETIN_LIST_DEFAULT_LIMIT = 50;

/** 解析后的列表查询参数；`baseline` 固定为 false（记录页始终排除基线）。 */
export interface BulletinListRequestQuery {
  limit: number;
  offset: number;
  sourceNs?: string;
  status?: BulletinFilterStatus;
  baseline: false;
}

function parseIntegerParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/**
 * 解析并校验列表查询参数（纯函数，便于单测）。
 *
 * `status` 缺省或为空串表示「全部」；非法枚举抛 400 INVALID_BODY，
 * 交由 `handleRoute` 转成中文错误响应。limit/offset 非整数时回退默认值，
 * 越界由仓库层统一 clamp。
 */
export function parseBulletinListQuery(
  params: URLSearchParams,
): BulletinListRequestQuery {
  const rawStatus = params.get("status");
  let status: BulletinFilterStatus | undefined;
  if (rawStatus !== null && rawStatus.trim() !== "") {
    if (!isBulletinFilterStatus(rawStatus)) {
      throw new HttpError(
        "INVALID_BODY",
        "status 取值不合法，只能是 pending、matched、uncertain、failed 或 not_matched",
        400,
      );
    }
    status = rawStatus;
  }

  const sourceNs = params.get("sourceNs")?.trim();

  return {
    limit: parseIntegerParam(params.get("limit"), BULLETIN_LIST_DEFAULT_LIMIT),
    offset: parseIntegerParam(params.get("offset"), 0),
    sourceNs: sourceNs ? sourceNs : undefined,
    status,
    baseline: false,
  };
}
