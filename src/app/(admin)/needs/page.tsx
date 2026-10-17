"use client";

import { useState, type ReactNode } from "react";
import { Button, Modal, Switch, TextInput } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  NEEDS_PAGE_SIZE,
  type NeedDto,
  type PagedItems,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { List, ListItem, Eyebrow } from "@/components/ui/List";
import { Pagination } from "@/components/ui/Pagination";
import { Feedback } from "@/components/ui/Feedback";
import { clampPage } from "@/components/pagination-model";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function NeedsPage() {
  const [page, setPage] = useState(0);
  const path = `/api/needs?limit=${NEEDS_PAGE_SIZE}&offset=${page * NEEDS_PAGE_SIZE}`;
  const { data, error, loading, reload } = useApiResource<PagedItems<NeedDto>>(path);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NeedDto | null>(null);

  // 删除/数据缩减导致页码越界时，在渲染期收敛到最后一个有效页。
  // 用「比较后修正 state」而不是 useEffect（react-hooks/set-state-in-effect）；
  // 修正只在越界的那一次渲染发生，条件随后不再成立。
  const total = data?.total ?? null;
  if (total !== null) {
    const clamped = clampPage(page, total, NEEDS_PAGE_SIZE);
    if (clamped !== page) setPage(clamped);
  }
  const safePage = total === null ? page : clampPage(page, total, NEEDS_PAGE_SIZE);

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
    await run(() => apiSend(`/api/needs/${need.id}`, "DELETE"));
    setPendingDelete(null);
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
          <TextInput
            label="需求名称"
            placeholder="需求名称，例如：抽纸"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={100}
            style={{ flex: "1 1 200px" }}
          />
          <TextInput
            label="备注（可选）"
            placeholder="可选备注，例如：不要湿巾"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            maxLength={500}
            style={{ flex: "2 1 320px" }}
          />
          <Button
            type="submit"
            loading={busy}
            disabled={!name.trim()}
            style={{ alignSelf: "flex-end" }}
          >
            新增需求
          </Button>
        </form>
      </Section>

      <Section title="现有需求">
        {loading && !data ? <Feedback kind="loading">正在加载…</Feedback> : null}
        {data && data.total === 0 ? (
          <p className="empty">还没有需求。添加后，之后出现的新线报会逐项判断。</p>
        ) : null}
        {data && data.total > 0 && needs.length === 0 ? (
          <p className="empty">本页没有记录。</p>
        ) : null}

        {needs.length > 0 ? (
          <List>
            {needs.map((need) => {
              // 启停状态由行尾 `Switch` 直接表达，eyebrow 不再重复一遍徽标文案。
              const eyebrowItems: ReactNode[] = [
                `v${need.version}`,
                `更新于 ${formatTime(need.updatedAt)}`,
              ];

              return (
                <ListItem key={need.id}>
                  <div className="list-body">
                    <div>
                      <Eyebrow items={eyebrowItems} />
                      <TextInput
                        key={`${need.id}:${need.version}:name`}
                        defaultValue={need.name}
                        aria-label="需求名称"
                        disabled={busy}
                        variant="unstyled"
                        classNames={{ input: "list-title" }}
                        onBlur={(event) => {
                          const next = event.currentTarget.value.trim();
                          if (next && next !== need.name) {
                            void run(() =>
                              apiSend(`/api/needs/${need.id}`, "PATCH", { name: next }),
                            );
                          } else if (!next) {
                            event.currentTarget.value = need.name;
                          }
                        }}
                      />
                      <TextInput
                        key={`${need.id}:${need.version}:note`}
                        defaultValue={need.note}
                        aria-label="需求备注"
                        placeholder="添加备注（可选）"
                        disabled={busy}
                        variant="unstyled"
                        classNames={{ input: "list-note" }}
                        onBlur={(event) => {
                          if (event.currentTarget.value !== need.note) {
                            void run(() =>
                              apiSend(`/api/needs/${need.id}`, "PATCH", {
                                note: event.currentTarget.value,
                              }),
                            );
                          }
                        }}
                      />
                    </div>
                    <div className="list-trailing">
                      <Switch
                        size="sm"
                        checked={need.enabled}
                        disabled={busy}
                        aria-label={need.enabled ? "停用该需求" : "启用该需求"}
                        onChange={(event) =>
                          void run(() =>
                            apiSend(`/api/needs/${need.id}`, "PATCH", {
                              enabled: event.currentTarget.checked,
                            }),
                          )
                        }
                      />
                      <Button
                        variant="subtle"
                        color="red"
                        size="sm"
                        disabled={busy}
                        onClick={() => setPendingDelete(need)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                </ListItem>
              );
            })}
          </List>
        ) : null}

        {data && data.total > 0 ? (
          <Pagination
            page={safePage}
            total={data.total}
            pageSize={NEEDS_PAGE_SIZE}
            onPage={setPage}
            unit="条"
          />
        ) : null}
      </Section>

      <Modal
        opened={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除需求"
        centered
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            删除需求「{pendingDelete?.name}」？历史判断记录会保留需求快照。
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => setPendingDelete(null)}
            >
              取消
            </Button>
            <Button
              color="red"
              size="sm"
              loading={busy}
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete);
              }}
            >
              删除
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
