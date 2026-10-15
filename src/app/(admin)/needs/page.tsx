"use client";

import { useState } from "react";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import type { NeedDto } from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";

interface NeedsResponse {
  items: NeedDto[];
}

export default function NeedsPage() {
  const { data, error, loading, reload } = useApiResource<NeedsResponse>("/api/needs");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setActionError(null);
      await reload();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      await apiSend("/api/needs", "POST", { name: name.trim(), note: note.trim() });
      setName("");
      setNote("");
    });
  }

  async function remove(need: NeedDto) {
    if (!window.confirm(`删除需求「${need.name}」？历史判断记录会保留需求快照。`)) {
      return;
    }
    await run(() => apiSend(`/api/needs/${need.id}`, "DELETE"));
  }

  const needs = data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="需求清单"
        lead="只填写需求名称与可选自然语言备注即可，例如「抽纸」+「不要湿巾」。修改只影响之后的新线报，不会自动回放历史线报。名称或备注修改后离开输入框即保存。"
      />

      {error && !data ? <Feedback kind="error">加载失败：{error}</Feedback> : null}
      {error && data ? (
        <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback>
      ) : null}
      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}

      <Section title="新增需求">
        <form className="row" onSubmit={create}>
          <label className="field" style={{ flex: "1 1 200px" }}>
            需求名称
            <input
              placeholder="需求名称，例如：抽纸"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
          </label>
          <label className="field" style={{ flex: "2 1 320px" }}>
            备注（可选）
            <input
              placeholder="可选备注，例如：不要湿巾"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
            />
          </label>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy}
            style={{ alignSelf: "flex-end" }}
          >
            新增需求
          </button>
        </form>
      </Section>

      <Section title="现有需求">
        {loading && !data ? <Feedback kind="loading">正在加载…</Feedback> : null}
        {!loading && needs.length === 0 ? (
          <p className="empty">还没有需求。添加后，之后出现的新线报会逐项判断。</p>
        ) : null}
        {needs.length > 0 ? (
          <TableScroll label="需求清单" minTableWidth={860}>
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>备注</th>
                  <th>状态</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {needs.map((need) => (
                  <tr key={need.id}>
                    <td>
                      <input
                        key={`${need.id}:${need.version}:name`}
                        defaultValue={need.name}
                        aria-label="需求名称"
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (next && next !== need.name) {
                            void run(() =>
                              apiSend(`/api/needs/${need.id}`, "PATCH", { name: next }),
                            );
                          } else if (!next) {
                            event.target.value = need.name;
                          }
                        }}
                      />
                    </td>
                    <td>
                      <input
                        key={`${need.id}:${need.version}:note`}
                        defaultValue={need.note}
                        aria-label="需求备注"
                        onBlur={(event) => {
                          if (event.target.value !== need.note) {
                            void run(() =>
                              apiSend(`/api/needs/${need.id}`, "PATCH", {
                                note: event.target.value,
                              }),
                            );
                          }
                        }}
                      />
                    </td>
                    <td>
                      <span className={`badge ${need.enabled ? "matched" : "baseline"}`}>
                        {need.enabled ? "已启用" : "已停用"}
                      </span>
                    </td>
                    <td className="small">v{need.version}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              apiSend(`/api/needs/${need.id}`, "PATCH", {
                                enabled: !need.enabled,
                              }),
                            )
                          }
                        >
                          {need.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost danger"
                          disabled={busy}
                          onClick={() => void remove(need)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        ) : null}
      </Section>
    </div>
  );
}
