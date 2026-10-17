"use client";

import { useState } from "react";
import { Button, Checkbox, Radio } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  CHANNELS_PAGE_SIZE,
  type ChannelDto,
  type ChannelSelectionDto,
  type ChannelStatsDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Pagination } from "@/components/ui/Pagination";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";
import { clampPage } from "@/components/pagination-model";

interface ChannelsResponse {
  channels: ChannelDto[];
  selection: ChannelSelectionDto;
  stats: ChannelStatsDto;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** 用服务端选择生成稳定 key，用于判断选择是否发生变化（不参与渲染）。 */
function selectionKey(selection: ChannelSelectionDto): string {
  return `${selection.mode}\u0000${selection.customIds.join("\u0000")}`;
}

export default function ChannelsPage() {
  const [page, setPage] = useState(0);
  const path = `/api/channels?limit=${CHANNELS_PAGE_SIZE}&offset=${page * CHANNELS_PAGE_SIZE}`;
  const { data, error, reload } = useApiResource<ChannelsResponse>(path, {
    refreshMs: 30000,
  });

  // 选择状态挂在页面上层：翻页会让 `data` 短暂清空，若放在会被卸载的子组件里，
  // 跨页勾选就会丢失。这里以「服务端选择变化才重置本地编辑态」的方式同步，
  // 翻页与定时刷新都不会覆盖用户尚未保存的勾选。
  const [mode, setMode] = useState<"all" | "custom">("all");
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const serverKey = data ? selectionKey(data.selection) : null;
  if (data && serverKey !== appliedKey) {
    setAppliedKey(serverKey);
    setMode(data.selection.mode);
    setCustomIds(data.selection.customIds);
  }

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 数据缩减导致页码越界时在渲染期收敛（不用 set-state-in-effect，见 bulletins 页）。
  const total = data?.stats.total ?? null;
  if (total !== null) {
    const clamped = clampPage(page, total, CHANNELS_PAGE_SIZE);
    if (clamped !== page) setPage(clamped);
  }
  const safePage = total === null ? page : clampPage(page, total, CHANNELS_PAGE_SIZE);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      setActionError(null);
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setMode("custom");
    setCustomIds((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id],
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        <PageHeader title="采集频道" />
        <Feedback kind="error">加载失败：{error}</Feedback>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="采集频道"
        lead="默认采集全部开放频道。首次成功获取某个频道的快照时只建立基线，不调用模型、不通知；之后新出现的线报才会进入判断。分类流与值得买独立流分别适配，重复来源按来源编号空间去重。"
        actions={
          <Button
            variant="default"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => apiSend("/api/channels/refresh", "POST", {}),
                "已从官方能力清单刷新频道列表。",
              )
            }
          >
            刷新官方频道清单
          </Button>
        }
      />

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind="success">{notice}</Feedback> : null}
      {error && data ? (
        <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback>
      ) : null}

      {!data ? (
        <Feedback kind="loading">正在加载…</Feedback>
      ) : (
        <Section
          title="采集选择"
          description={
            <>
              共 {data.stats.total} 个频道，已启用 {data.stats.selected} 个，已建立基线{" "}
              {data.stats.initialized} 个
              {data.stats.failing > 0 ? `，${data.stats.failing} 个频道存在错误` : ""}。
            </>
          }
        >
          <div className="stack">
            <div className="toolbar">
              <Radio.Group
                value={mode}
                onChange={(next) => setMode(next as "all" | "custom")}
                aria-label="采集选择模式"
              >
                <div className="stack">
                  <Radio
                    value="all"
                    label="全部开放频道（跟随能力清单，新增频道自动纳入）"
                  />
                  <Radio
                    value="custom"
                    label={`自定义选择（已选 ${customIds.length} 个，含其它页）`}
                  />
                </div>
              </Radio.Group>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => apiSend("/api/channels/selection", "PUT", { mode, customIds }),
                    "采集选择已保存，worker 会在下一轮按新选择调度。",
                  )
                }
              >
                保存选择
              </Button>
            </div>

            {data.stats.total === 0 ? (
              <p className="empty">
                尚无频道清单。点击「刷新官方频道清单」从官方 meta 获取；worker 也会自动同步。
              </p>
            ) : data.channels.length === 0 ? (
              <p className="empty">本页没有频道。</p>
            ) : (
              <TableScroll label="采集频道清单" minTableWidth={860}>
                <table>
                  <thead>
                    <tr>
                      <th>采集</th>
                      <th>频道</th>
                      <th>类型</th>
                      <th>基线</th>
                      <th>最后成功</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.channels.map((channel) => {
                      const selected =
                        mode === "all"
                          ? channel.selected && channel.available
                          : customIds.includes(channel.id);
                      return (
                        <tr key={channel.id}>
                          <td>
                            <Checkbox
                              aria-label={`采集 ${channel.name}`}
                              checked={selected && channel.available}
                              disabled={!channel.available || busy}
                              onChange={() => toggle(channel.id)}
                            />
                          </td>
                          <td>{channel.name}</td>
                          <td className="small">
                            {channel.origin === "zdm" ? "值得买独立流" : "分类流"}
                          </td>
                          <td>
                            <StatusBadge
                              status={channel.initialized ? "matched" : "pending"}
                            >
                              {channel.initialized ? "已建立" : "未初始化"}
                            </StatusBadge>
                          </td>
                          <td className="small">{formatTime(channel.lastSuccessAt)}</td>
                          <td className="small">
                            {!channel.available ? (
                              <span className="muted">已从能力清单撤下</span>
                            ) : channel.lastError ? (
                              <span className="error">{channel.lastError}</span>
                            ) : (
                              <span className="muted">正常</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}

            {data.stats.total > 0 ? (
              <Pagination
                page={safePage}
                total={data.stats.total}
                pageSize={CHANNELS_PAGE_SIZE}
                onPage={setPage}
                unit="个频道"
              />
            ) : null}
          </div>
        </Section>
      )}
    </div>
  );
}
