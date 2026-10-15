"use client";

import { useState } from "react";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import type {
  ChannelDto,
  ChannelSelectionDto,
  ChannelStatsDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";

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

function SelectionForm(props: {
  initial: ChannelSelectionDto;
  channels: ChannelDto[];
  disabled: boolean;
  onSave: (selection: ChannelSelectionDto) => void;
}) {
  const [mode, setMode] = useState<"all" | "custom">(props.initial.mode);
  const [customIds, setCustomIds] = useState<string[]>(props.initial.customIds);

  function toggle(id: string) {
    setMode("custom");
    setCustomIds((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id],
    );
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="toolbar-start">
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "all"}
              onChange={() => setMode("all")}
            />{" "}
            全部开放频道（跟随能力清单，新增频道自动纳入）
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "custom"}
              onChange={() => setMode("custom")}
            />{" "}
            自定义选择
          </label>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={props.disabled}
          onClick={() => props.onSave({ mode, customIds })}
        >
          保存选择
        </button>
      </div>

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
            {props.channels.map((channel) => {
              const selected =
                mode === "all"
                  ? channel.selected && channel.available
                  : customIds.includes(channel.id);
              return (
                <tr key={channel.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`采集 ${channel.name}`}
                      checked={selected && channel.available}
                      disabled={!channel.available}
                      onChange={() => toggle(channel.id)}
                    />
                  </td>
                  <td>{channel.name}</td>
                  <td className="small">
                    {channel.origin === "zdm" ? "值得买独立流" : "分类流"}
                  </td>
                  <td>
                    <span className={`badge ${channel.initialized ? "matched" : "pending"}`}>
                      {channel.initialized ? "已建立" : "未初始化"}
                    </span>
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
    </div>
  );
}

export default function ChannelsPage() {
  const { data, error, loading, reload } = useApiResource<ChannelsResponse>(
    "/api/channels",
    { refreshMs: 30000 },
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  if (error && !data) {
    return (
      <div className="page">
        <PageHeader title="采集频道" />
        <Feedback kind="error">加载失败：{error}</Feedback>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="采集频道" />
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="采集频道"
        lead="默认采集全部开放频道。首次成功获取某个频道的快照时只建立基线，不调用模型、不通知；之后新出现的线报才会进入判断。分类流与值得买独立流分别适配，重复来源按来源编号空间去重。"
        actions={
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => apiSend("/api/channels/refresh", "POST", {}),
                "已从官方能力清单刷新频道列表。",
              )
            }
          >
            刷新官方频道清单
          </button>
        }
      />

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind="success">{notice}</Feedback> : null}
      {error ? <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback> : null}

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
        {data.channels.length === 0 ? (
          <p className="empty">
            尚无频道清单。点击「刷新官方频道清单」从官方 meta 获取；worker 也会自动同步。
          </p>
        ) : (
          <SelectionForm
            key={`${data.selection.mode}:${data.selection.customIds.join(",")}`}
            initial={data.selection}
            channels={data.channels}
            disabled={busy}
            onSave={(selection) =>
              void run(
                () => apiSend("/api/channels/selection", "PUT", selection),
                "采集选择已保存，worker 会在下一轮按新选择调度。",
              )
            }
          />
        )}
      </Section>
    </div>
  );
}
