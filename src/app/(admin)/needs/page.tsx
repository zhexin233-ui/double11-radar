"use client";

import { useState, type ReactNode } from "react";
import { Badge, Button, Modal, Switch, TextInput } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import {
  type NeedDto,
  type NeedGroupDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { List, ListItem, Eyebrow } from "@/components/ui/List";
import { Feedback } from "@/components/ui/Feedback";

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

interface GroupsResponse {
  groups: NeedGroupDto[];
}

export default function NeedsPage() {
  const path = `/api/need-groups?includeNeeds=true`;
  const { data, error, loading, reload } = useApiResource<GroupsResponse>(path);

  // 新增分组表单状态
  const [newGroupName, setNewGroupName] = useState("");

  // 新增需求表单状态（针对各分组的局部输入，按 groupId 映射）
  const [needInputs, setNeedInputs] = useState<
    Record<string, { name: string; note: string }>
  >({});

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 待删除的分组与需求
  const [pendingDeleteGroup, setPendingDeleteGroup] =
    useState<NeedGroupDto | null>(null);
  const [pendingDeleteNeed, setPendingDeleteNeed] =
    useState<NeedDto | null>(null);

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

  // 创建新分组
  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    await run(async () => {
      await apiSend("/api/need-groups", "POST", { name: trimmed });
      setNewGroupName("");
    });
  }

  // 组内新增需求
  async function createNeedForGroup(groupId: string, event: React.FormEvent) {
    event.preventDefault();
    const current = needInputs[groupId] ?? { name: "", note: "" };
    if (!current.name.trim()) return;
    await run(async () => {
      await apiSend("/api/needs", "POST", {
        groupId,
        name: current.name.trim(),
        note: current.note.trim(),
      });
      setNeedInputs((prev) => ({
        ...prev,
        [groupId]: { name: "", note: "" },
      }));
    });
  }

  // 删除分组
  async function removeGroup(group: NeedGroupDto) {
    await run(() => apiSend(`/api/need-groups/${group.id}`, "DELETE"));
    setPendingDeleteGroup(null);
  }

  // 删除需求
  async function removeNeed(need: NeedDto) {
    await run(() => apiSend(`/api/needs/${need.id}`, "DELETE"));
    setPendingDeleteNeed(null);
  }

  const groups = data?.groups ?? [];

  return (
    <div className="page">
      <PageHeader
        title="需求清单"
        lead="按分组组织与管理需求。支持一键启停整个分组；只有在所属分组已启用且需求项自身也启用的情况下，才会参与新线报的智能匹配判定。"
      />

      {error && !data ? <Feedback kind="error">加载失败：{error}</Feedback> : null}
      {error && data ? (
        <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback>
      ) : null}
      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}

      <Section title="新增分组">
        <form className="row" onSubmit={createGroup}>
          <TextInput
            placeholder="分组名称，例如：日用百货、数码电子"
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.currentTarget.value)}
            maxLength={100}
            style={{ flex: "1 1 300px" }}
          />
          <Button
            type="submit"
            loading={busy}
            disabled={!newGroupName.trim()}
          >
            创建分组
          </Button>
        </form>
      </Section>

      {loading && !data ? <Feedback kind="loading">正在加载需求分组…</Feedback> : null}
      {data && groups.length === 0 ? (
        <Section title="现有需求">
          <p className="empty">还没有任何分组。请先在上方创建一个分组。</p>
        </Section>
      ) : null}

      {groups.map((group) => {
        const needs = group.needs ?? [];
        const enabledCount = needs.filter((n) => n.enabled).length;
        const inputState = needInputs[group.id] ?? { name: "", note: "" };

        return (
          <Section
            key={group.id}
            title={
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  gap: "1rem",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <TextInput
                    key={`${group.id}:name`}
                    defaultValue={group.name}
                    aria-label="分组名称"
                    disabled={busy}
                    variant="unstyled"
                    styles={{
                      input: {
                        fontWeight: 600,
                        fontSize: "1.1rem",
                        padding: 0,
                        height: "auto",
                        minHeight: 0,
                      },
                    }}
                    onBlur={(event) => {
                      const next = event.currentTarget.value.trim();
                      if (next && next !== group.name) {
                        void run(() =>
                          apiSend(`/api/need-groups/${group.id}`, "PATCH", {
                            name: next,
                          }),
                        );
                      } else if (!next) {
                        event.currentTarget.value = group.name;
                      }
                    }}
                  />
                  <Badge
                    variant="light"
                    color={group.enabled ? "blue" : "gray"}
                    size="sm"
                  >
                    {group.enabled
                      ? `${enabledCount}/${needs.length} 已生效`
                      : "分组已关闭"}
                  </Badge>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                  <Switch
                    checked={group.enabled}
                    disabled={busy}
                    label={group.enabled ? "分组开启" : "分组关闭"}
                    onChange={(event) =>
                      void run(() =>
                        apiSend(`/api/need-groups/${group.id}`, "PATCH", {
                          enabled: event.currentTarget.checked,
                        }),
                      )
                    }
                  />
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-sm"
                    disabled={busy}
                    onClick={() => setPendingDeleteGroup(group)}
                  >
                    删除分组
                  </Button>
                </div>
              </div>
            }
          >
            {/* 组内添加需求输入栏 */}
            <form
              className="row"
              style={{ marginBottom: "1rem" }}
              onSubmit={(e) => createNeedForGroup(group.id, e)}
            >
              <TextInput
                placeholder="需求名称，例如：抽纸"
                value={inputState.name}
                onChange={(event) => {
                  const val = event.currentTarget.value;
                  setNeedInputs((prev) => ({
                    ...prev,
                    [group.id]: {
                      ...(prev[group.id] ?? { note: "" }),
                      name: val,
                    },
                  }));
                }}
                maxLength={100}
                style={{ flex: "1 1 180px" }}
              />
              <TextInput
                placeholder="备注（可选），例如：不要湿巾"
                value={inputState.note}
                onChange={(event) => {
                  const val = event.currentTarget.value;
                  setNeedInputs((prev) => ({
                    ...prev,
                    [group.id]: {
                      ...(prev[group.id] ?? { name: "" }),
                      note: val,
                    },
                  }));
                }}
                maxLength={500}
                style={{ flex: "2 1 240px" }}
              />
              <Button
                type="submit"
                size="sm"
                loading={busy}
                disabled={!inputState.name.trim()}
              >
                添加需求
              </Button>
            </form>

            {/* 组内需求列表 */}
            {needs.length === 0 ? (
              <p className="empty" style={{ margin: "0.5rem 0" }}>
                该组暂无需求，请在上方添加。
              </p>
            ) : (
              <List>
                {needs.map((need) => {
                  const eyebrowItems: ReactNode[] = [
                    `v${need.version}`,
                    `更新于 ${formatTime(need.updatedAt)}`,
                    !group.enabled ? "所属分组已关闭" : null,
                  ].filter(Boolean);

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
                                  apiSend(`/api/needs/${need.id}`, "PATCH", {
                                    name: next,
                                  }),
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
                            onClick={() => setPendingDeleteNeed(need)}
                          >
                            删除
                          </Button>
                        </div>
                      </div>
                    </ListItem>
                  );
                })}
              </List>
            )}
          </Section>
        );
      })}

      {/* 删除需求确认弹窗 */}
      <Modal
        opened={pendingDeleteNeed !== null}
        onClose={() => setPendingDeleteNeed(null)}
        title="删除需求"
        centered
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            删除需求「{pendingDeleteNeed?.name}」？历史判断记录会保留需求快照。
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => setPendingDeleteNeed(null)}
            >
              取消
            </Button>
            <Button
              color="red"
              size="sm"
              loading={busy}
              onClick={() => {
                if (pendingDeleteNeed) void removeNeed(pendingDeleteNeed);
              }}
            >
              删除
            </Button>
          </div>
        </div>
      </Modal>

      {/* 删除分组确认弹窗 */}
      <Modal
        opened={pendingDeleteGroup !== null}
        onClose={() => setPendingDeleteGroup(null)}
        title="删除分组"
        centered
      >
        <div className="stack">
          <p style={{ margin: 0, color: "var(--mantine-color-red-6)" }}>
            确定要删除分组「{pendingDeleteGroup?.name}」吗？
          </p>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--mantine-color-dimmed)" }}>
            注意：该操作将级联删除该分组下的全部需求（共 {pendingDeleteGroup?.needs?.length ?? 0} 项），历史已判定的线报记录不会丢失。
          </p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => setPendingDeleteGroup(null)}
            >
              取消
            </Button>
            <Button
              color="red"
              size="sm"
              loading={busy}
              onClick={() => {
                if (pendingDeleteGroup) void removeGroup(pendingDeleteGroup);
              }}
            >
              确认删除
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
