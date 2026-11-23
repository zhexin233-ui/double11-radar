"use client";

import { useState } from "react";
import { Button, Modal, NumberInput, Switch } from "@mantine/core";
import { useApiResource } from "@/components/use-api";
import { apiSend, errorMessage } from "@/components/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";
import type {
  StorageDataDto,
  CleanupResultDto,
  VacuumResultDto,
} from "@/components/api-types";

function formatDateTime(iso: string | null): string {
  if (!iso) return "暂无记录";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "暂无记录" : date.toLocaleString();
}

export default function StorageSettingsPage() {
  const { data, error, loading, reload } = useApiResource<StorageDataDto>(
    "/api/settings/storage",
    { refreshMs: 30000 },
  );

  // 表单状态：支持用户本地修改；若未修改过则回退到服务端数据
  const [retentionDaysInput, setRetentionDaysInput] = useState<
    number | string | null
  >(null);
  const [autoCleanupInput, setAutoCleanupInput] = useState<boolean | null>(
    null,
  );
  const [cleanOnlyUnmatchedInput, setCleanOnlyUnmatchedInput] = useState<
    boolean | null
  >(null);

  const retentionDays =
    retentionDaysInput ?? data?.settings.retentionDays ?? 30;
  const autoCleanupEnabled =
    autoCleanupInput ?? data?.settings.autoCleanupEnabled ?? true;
  const cleanOnlyUnmatched =
    cleanOnlyUnmatchedInput ?? data?.settings.cleanOnlyUnmatched ?? false;

  const [saving, setSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);

  // 清理操作状态
  const [cleaning, setCleaning] = useState(false);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResultDto | null>(
    null,
  );

  // 整理空间 (VACUUM) 状态
  const [vacuuming, setVacuuming] = useState(false);
  const [vacuumResult, setVacuumResult] = useState<VacuumResultDto | null>(
    null,
  );

  // 维护操作错误（取代原生 alert）
  const [maintError, setMaintError] = useState<string | null>(null);

  // 保存设置
  async function handleSaveSettings() {
    setSaving(true);
    setSaveSuccessMsg(null);
    setSaveErrorMsg(null);
    try {
      const parsedDays =
        typeof retentionDays === "number"
          ? retentionDays
          : parseInt(String(retentionDays), 10);
      await apiSend<StorageDataDto>("/api/settings/storage", "PUT", {
        retentionDays: Number.isNaN(parsedDays) ? 0 : parsedDays,
        autoCleanupEnabled,
        cleanOnlyUnmatched,
      });
      setSaveSuccessMsg("存储设置已保存。");
      setRetentionDaysInput(null);
      setAutoCleanupInput(null);
      setCleanOnlyUnmatchedInput(null);
      await reload();
    } catch (caught) {
      setSaveErrorMsg(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  // 手动执行清理
  async function handleExecuteCleanup() {
    setCleaning(true);
    setMaintError(null);
    try {
      const parsedDays =
        typeof retentionDays === "number"
          ? retentionDays
          : parseInt(String(retentionDays), 10);
      const res = await apiSend<CleanupResultDto>(
        "/api/settings/storage/cleanup",
        "POST",
        {
          retentionDays: Number.isNaN(parsedDays) ? 0 : parsedDays,
          cleanOnlyUnmatched,
        },
      );
      setCleanupResult(res);
      setCleanupModalOpen(false);
      await reload();
    } catch (caught) {
      setMaintError(`清理失败：${errorMessage(caught)}`);
      setCleanupModalOpen(false);
    } finally {
      setCleaning(false);
    }
  }

  // 手动执行 VACUUM
  async function handleExecuteVacuum() {
    setVacuuming(true);
    setMaintError(null);
    try {
      const res = await apiSend<VacuumResultDto>(
        "/api/settings/storage/vacuum",
        "POST",
        {},
      );
      setVacuumResult(res);
      await reload();
    } catch (caught) {
      setMaintError(`整理数据库空间失败：${errorMessage(caught)}`);
    } finally {
      setVacuuming(false);
    }
  }

  const header = (
    <PageHeader
      title="存储设置"
      lead="管理历史线报生命周期与数据库文件存储，避免海量无用线报无限膨胀耗尽磁盘。"
      actions={
        <Button
          variant="default"
          size="sm"
          onClick={() => void reload()}
          loading={loading && Boolean(data)}
        >
          刷新
        </Button>
      }
    />
  );

  if (error && !data) {
    return (
      <div className="page">
        {header}
        <Feedback kind="error">加载存储设置失败：{error}</Feedback>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        {header}
        <Feedback kind="loading">正在加载存储与空间统计…</Feedback>
      </div>
    );
  }

  const { settings, stats } = data;

  return (
    <div className="page">
      {header}

      {error ? (
        <Feedback kind="error">
          刷新失败：{error}（下方为上次成功数据）
        </Feedback>
      ) : null}

      {cleanupResult ? (
        <Feedback kind="success">
          清理完成：成功清理 <strong>{cleanupResult.cleanedBulletins}</strong>{" "}
          条超期历史线报，级联删除 {cleanupResult.cleanedEvaluations} 条评估、
          {cleanupResult.cleanedDeliveries} 条投递，耗时{" "}
          {cleanupResult.durationMs}ms。
        </Feedback>
      ) : null}

      {vacuumResult ? (
        <Feedback kind="success">
          数据库碎片整理完成：已执行 VACUUM，当前释放磁盘空间{" "}
          <strong>{vacuumResult.savedFormatted}</strong>。
        </Feedback>
      ) : null}

      {maintError ? <Feedback kind="error">{maintError}</Feedback> : null}

      {/* 空间概览 */}
      <Section title="存储空间占用">
        <div className="stats">
          <div className="stat-cell">
            <div className="stat-label">总存储占用空间</div>
            <div className="stat-value mono">{stats.totalSizeFormatted}</div>
            <div className="stat-hint">包含主库、WAL 与 SHM 临时缓存文件</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">SQLite 主库文件</div>
            <div className="stat-value mono">{stats.dbSizeFormatted}</div>
            <div className="stat-hint mono">{stats.dbPath}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">WAL 临时日志占用</div>
            <div className="stat-value mono">{stats.walSizeFormatted}</div>
            <div className="stat-hint">
              事务日志，Checkpoint 后自动合并回主库
            </div>
          </div>
        </div>
      </Section>

      {/* 数据规模与表统计 */}
      <Section title="数据规模统计">
        <div className="stats">
          <div className="stat-cell">
            <div className="stat-label">历史线报总数</div>
            <div className="stat-value">{stats.tableCounts.bulletins}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">超期可清理线报</div>
            <div
              className={
                stats.expiredBulletinsCount > 0
                  ? "stat-value warning"
                  : "stat-value"
              }
            >
              {stats.expiredBulletinsCount}
            </div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">模型评估记录</div>
            <div className="stat-value">{stats.tableCounts.evaluations}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">消息投递记录</div>
            <div className="stat-value">{stats.tableCounts.deliveries}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">模型请求账本</div>
            <div className="stat-value">{stats.tableCounts.jevRequests}</div>
          </div>
        </div>
      </Section>

      <div className="grid-2">
        {/* 存储清理策略配置 */}
        <Section title="自动清理策略" alt>
          <div className="stack">
            {saveSuccessMsg ? (
              <Feedback kind="success">{saveSuccessMsg}</Feedback>
            ) : null}
            {saveErrorMsg ? (
              <Feedback kind="error">{saveErrorMsg}</Feedback>
            ) : null}

            <NumberInput
              label="历史线报保留天数"
              description="线报入库超过该天数后将自动清理。设置为 0 则永不自动清理。"
              value={retentionDays}
              onChange={(val) => setRetentionDaysInput(val)}
              min={0}
              max={3650}
              style={{ maxWidth: 320 }}
            />

            <Switch
              label="开启后台周期性自动清理"
              description="后台 Worker 每小时会自动扫描一次，根据保留天数分批清理超期历史线报及其附属评估记录。"
              checked={autoCleanupEnabled}
              onChange={(e) => setAutoCleanupInput(e.currentTarget.checked)}
            />

            <Switch
              label="仅清理未命中的线报（保留命中的历史线报）"
              description="开启后，已经明确命中需求或已生成通知投递的历史线报将永远保留，仅清理未命中需求的普通线报。"
              checked={cleanOnlyUnmatched}
              onChange={(e) =>
                setCleanOnlyUnmatchedInput(e.currentTarget.checked)
              }
            />

            <div className="stack-sm" style={{ paddingTop: "var(--sp-2)" }}>
              <div className="row">
                <Button
                  onClick={() => void handleSaveSettings()}
                  loading={saving}
                >
                  保存策略设置
                </Button>
              </div>
              <p className="muted small mono" style={{ margin: 0 }}>
                上次自动/手动清理：{formatDateTime(settings.lastCleanupAt)}
                {settings.lastCleanedCount !== null &&
                settings.lastCleanedCount !== undefined
                  ? `（清理了 ${settings.lastCleanedCount} 条）`
                  : ""}
              </p>
            </div>
          </div>
        </Section>

        {/* 手动空间维护 */}
        <Section title="空间手动维护" alt>
          <div className="stack">
            <div className="stack-sm">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>立即清理超期数据</h3>
                <StatusBadge
                  status={
                    stats.expiredBulletinsCount > 0 ? "pending" : "baseline"
                  }
                >
                  {stats.expiredBulletinsCount} 条可释放
                </StatusBadge>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                根据当前设置的保留天数（{retentionDays} 天），立即清理符合条件的历史线报及其评估、投递流水。
              </p>
              <div className="row" style={{ marginTop: "var(--sp-2)" }}>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setCleanupModalOpen(true)}
                  disabled={
                    stats.expiredBulletinsCount === 0 &&
                    Number(retentionDays) > 0
                  }
                >
                  立即执行超期清理…
                </Button>
              </div>
            </div>

            <div className="divider-block stack-sm">
              <h3>整理数据库碎片（VACUUM）</h3>
              <p className="muted small" style={{ margin: 0 }}>
                大量清理线报后，SQLite 可能会在库内留下未分配的空间页。执行 VACUUM
                将重新组织数据库文件，把未使用的空间真正交还给操作系统磁盘。
              </p>
              <div className="row" style={{ marginTop: "var(--sp-2)" }}>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void handleExecuteVacuum()}
                  loading={vacuuming}
                >
                  执行 VACUUM 释放磁盘空间
                </Button>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* 确认清理 Modal */}
      <Modal
        opened={cleanupModalOpen}
        onClose={() => setCleanupModalOpen(false)}
        title="确认清理历史线报"
        centered
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            即将清理入库时间早于 <strong>{retentionDays} 天前</strong>{" "}
            的历史线报。
            {cleanOnlyUnmatched
              ? "（当前已配置：仅清理未命中需求的线报，命中的线报将得到保留）"
              : "（当前已配置：将清理所有超期的历史线报，包含已命中的记录）"}
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            注意：清理操作为物理删除，同时会级联清理该批线报的评估判定结果、处理流水和投递明细。
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              disabled={cleaning}
              onClick={() => setCleanupModalOpen(false)}
            >
              取消
            </Button>
            <Button
              color="red"
              size="sm"
              onClick={() => void handleExecuteCleanup()}
              loading={cleaning}
            >
              确认立即清理
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
