"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Grid,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Title,
  Badge,
  Modal,
  Alert,
} from "@mantine/core";
import { useApiResource } from "@/components/use-api";
import { apiSend } from "@/components/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { Feedback } from "@/components/ui/Feedback";
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
  const [retentionDaysInput, setRetentionDaysInput] = useState<number | string | null>(null);
  const [autoCleanupInput, setAutoCleanupInput] = useState<boolean | null>(null);
  const [cleanOnlyUnmatchedInput, setCleanOnlyUnmatchedInput] = useState<boolean | null>(null);

  const retentionDays = retentionDaysInput ?? data?.settings.retentionDays ?? 30;
  const autoCleanupEnabled = autoCleanupInput ?? data?.settings.autoCleanupEnabled ?? true;
  const cleanOnlyUnmatched = cleanOnlyUnmatchedInput ?? data?.settings.cleanOnlyUnmatched ?? false;

  const [saving, setSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);

  // 清理操作状态
  const [cleaning, setCleaning] = useState(false);
  const [cleanupModalOpen, setCleanupModalOpen] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResultDto | null>(null);

  // 整理空间 (VACUUM) 状态
  const [vacuuming, setVacuuming] = useState(false);
  const [vacuumResult, setVacuumResult] = useState<VacuumResultDto | null>(null);

  // 保存设置
  async function handleSaveSettings() {
    setSaving(true);
    setSaveSuccessMsg(null);
    setSaveErrorMsg(null);
    try {
      const parsedDays =
        typeof retentionDays === "number" ? retentionDays : parseInt(String(retentionDays), 10);
      await apiSend<StorageDataDto>("/api/settings/storage", "PUT", {
        retentionDays: isNaN(parsedDays) ? 0 : parsedDays,
        autoCleanupEnabled,
        cleanOnlyUnmatched,
      });
      setSaveSuccessMsg("存储设置保存成功");
      setRetentionDaysInput(null);
      setAutoCleanupInput(null);
      setCleanOnlyUnmatchedInput(null);
      await reload();
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch (err) {
      setSaveErrorMsg(err instanceof Error ? err.message : "保存设置失败");
    } finally {
      setSaving(false);
    }
  }

  // 手动执行清理
  async function handleExecuteCleanup() {
    setCleaning(true);
    try {
      const parsedDays =
        typeof retentionDays === "number" ? retentionDays : parseInt(retentionDays, 10);
      const res = await apiSend<CleanupResultDto>(
        "/api/settings/storage/cleanup",
        "POST",
        {
          retentionDays: isNaN(parsedDays) ? 0 : parsedDays,
          cleanOnlyUnmatched,
        },
      );
      setCleanupResult(res);
      setCleanupModalOpen(false);
      await reload();
    } catch (err) {
      alert("清理失败：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCleaning(false);
    }
  }

  // 手动执行 VACUUM
  async function handleExecuteVacuum() {
    setVacuuming(true);
    try {
      const res = await apiSend<VacuumResultDto>(
        "/api/settings/storage/vacuum",
        "POST",
        {},
      );
      setVacuumResult(res);
      await reload();
    } catch (err) {
      alert("整理数据库空间失败：" + (err instanceof Error ? err.message : String(err)));
    } finally {
      setVacuuming(false);
    }
  }

  const header = (
    <PageHeader
      title="存储设置"
      lead="管理历史线报生命周期与数据库文件存储，避免海量无用线报无限膨胀耗尽磁盘。"
      actions={
        <Button variant="default" size="sm" onClick={() => void reload()} loading={loading}>
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

      {/* 空间概览与看板 */}
      <Section title="存储空间看板" alt>
        <Grid>
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <Card withBorder padding="lg" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                总存储占用空间
              </Text>
              <Text fw={700} size="xl" mt="xs" c="blue">
                {stats.totalSizeFormatted}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                包含主库、WAL 与 SHM 临时缓存文件
              </Text>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, sm: 4 }}>
            <Card withBorder padding="lg" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                SQLite 主库文件
              </Text>
              <Text fw={700} size="xl" mt="xs">
                {stats.dbSizeFormatted}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                {stats.dbPath}
              </Text>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, sm: 4 }}>
            <Card withBorder padding="lg" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                WAL 临时日志占用
              </Text>
              <Text fw={700} size="xl" mt="xs">
                {stats.walSizeFormatted}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                事务日志，Checkpoint 后自动合并回主库
              </Text>
            </Card>
          </Grid.Col>
        </Grid>
      </Section>

      {/* 数据规模与表统计 */}
      <Section title="数据规模统计">
        <div className="stats">
          <div>
            <div className="stat-value">{stats.tableCounts.bulletins}</div>
            <div className="stat-label">历史线报总数</div>
          </div>
          <div>
            <div
              className={
                stats.expiredBulletinsCount > 0 ? "stat-value warning" : "stat-value"
              }
            >
              {stats.expiredBulletinsCount}
            </div>
            <div className="stat-label">超期可清理线报</div>
          </div>
          <div>
            <div className="stat-value">{stats.tableCounts.evaluations}</div>
            <div className="stat-label">模型评估记录</div>
          </div>
          <div>
            <div className="stat-value">{stats.tableCounts.deliveries}</div>
            <div className="stat-label">消息投递记录</div>
          </div>
          <div>
            <div className="stat-value">{stats.tableCounts.jevRequests}</div>
            <div className="stat-label">模型请求账本</div>
          </div>
        </div>
      </Section>

      {/* 操作与清理通知反馈 */}
      {cleanupResult && (
        <Alert
          title="清理完成"
          color="green"
          withCloseButton
          onClose={() => setCleanupResult(null)}
          mb="md"
        >
          成功清理 <b>{cleanupResult.cleanedBulletins}</b> 条超期历史线报，级联删除{" "}
          {cleanupResult.cleanedEvaluations} 条评估、{cleanupResult.cleanedDeliveries} 条投递，耗时{" "}
          {cleanupResult.durationMs}ms。
        </Alert>
      )}

      {vacuumResult && (
        <Alert
          title="数据库碎片整理完成"
          color="teal"
          withCloseButton
          onClose={() => setVacuumResult(null)}
          mb="md"
        >
          已执行 VACUUM，当前释放磁盘空间 <b>{vacuumResult.savedFormatted}</b>。
        </Alert>
      )}

      {/* 存储清理策略配置 */}
      <Section title="自动清理策略">
        <Stack gap="md">
          {saveSuccessMsg && <Feedback kind="success">{saveSuccessMsg}</Feedback>}
          {saveErrorMsg && <Feedback kind="error">{saveErrorMsg}</Feedback>}

          <NumberInput
            label="历史线报保留天数"
            description="线报入库超过该天数后将自动清理。设置为 0 则永不自动清理。"
            value={retentionDays}
            onChange={(val) => setRetentionDaysInput(val)}
            min={0}
            max={3650}
            style={{ maxWidth: 360 }}
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
            onChange={(e) => setCleanOnlyUnmatchedInput(e.currentTarget.checked)}
          />

          <Group gap="sm" mt="xs">
            <Button onClick={() => void handleSaveSettings()} loading={saving}>
              保存策略设置
            </Button>
            <Text size="xs" c="dimmed">
              上次自动/手动清理：{formatDateTime(settings.lastCleanupAt)}
              {settings.lastCleanedCount !== null && settings.lastCleanedCount !== undefined
                ? `（清理了 ${settings.lastCleanedCount} 条）`
                : ""}
            </Text>
          </Group>
        </Stack>
      </Section>

      {/* 手动空间维护 */}
      <Section title="空间手动维护" alt>
        <Stack gap="md">
          <div>
            <Title order={5} mb={4}>
              立即清理超期数据
            </Title>
            <Text size="sm" c="dimmed" mb="xs">
              根据当前设置的保留天数（{retentionDays} 天），当前有{" "}
              <Badge color={stats.expiredBulletinsCount > 0 ? "orange" : "gray"}>
                {stats.expiredBulletinsCount} 条
              </Badge>{" "}
              超期线报可立即释放。
            </Text>
            <Button
              color="orange"
              variant="light"
              onClick={() => setCleanupModalOpen(true)}
              disabled={stats.expiredBulletinsCount === 0 && Number(retentionDays) > 0}
            >
              立即执行超期清理…
            </Button>
          </div>

          <div style={{ paddingTop: 8, borderTop: "1px solid var(--mantine-color-default-border)" }}>
            <Title order={5} mb={4}>
              整理数据库碎片（VACUUM）
            </Title>
            <Text size="sm" c="dimmed" mb="xs">
              大量清理线报后，SQLite 可能会在库内留下未分配的空间页。执行 VACUUM
              将重新组织数据库文件，把未使用的空间真正交还给操作系统磁盘。
            </Text>
            <Button
              variant="outline"
              color="teal"
              onClick={() => void handleExecuteVacuum()}
              loading={vacuuming}
            >
              执行 VACUUM 释放磁盘空间
            </Button>
          </div>
        </Stack>
      </Section>

      {/* 确认清理 Modal */}
      <Modal
        opened={cleanupModalOpen}
        onClose={() => setCleanupModalOpen(false)}
        title="确认清理历史线报"
      >
        <Stack gap="md">
          <Text size="sm">
            即将清理入库时间早于 <b>{retentionDays} 天前</b> 的历史线报。
            {cleanOnlyUnmatched
              ? "（当前已配置：仅清理未命中需求的线报，命中的线报将得到保留）"
              : "（当前已配置：将清理所有超期的历史线报，包含已命中的记录）"}
          </Text>
          <Text size="xs" c="dimmed">
            注意：清理操作为物理删除，同时会级联清理该批线报的评估判定结果、处理流水和投递明细。
          </Text>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setCleanupModalOpen(false)}>
              取消
            </Button>
            <Button
              color="red"
              onClick={() => void handleExecuteCleanup()}
              loading={cleaning}
            >
              确认立即清理
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
