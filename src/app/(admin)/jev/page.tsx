"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Fieldset,
  Modal,
  NumberInput,
  Radio,
  Select,
  Tabs,
  Textarea,
  TextInput,
} from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import { DryRunPanel } from "@/components/DryRunPanel";
import { JevKeysPanel } from "@/components/JevKeysPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Pagination } from "@/components/ui/Pagination";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";
import { clampPage, pageSlice } from "@/components/pagination-model";
import { formatTime } from "@/components/format";
import {
  EVALUATION_MODE_OPTIONS,
  JE_CONCURRENCY_RANGE,
  JE_JOBS_PER_ROUND_RANGE,
  JE_KEY_FAILURE_THRESHOLD,
  JEV_USAGE_BY_KEY_PAGE_SIZE,
  JEV_USAGE_BY_KEY_PREVIEW,
  MAX_REGEX_RULE_LENGTH,
  MAX_REGEX_RULES,
  type EvaluationModeDto,
  type JevConfigDto,
  type JevKeyDto,
  type JevSettingsDto,
  type JevUsageByKeyDto,
  type JevUsageDto,
  type ModelChannelDto,
  type TestResultDto,
} from "@/components/api-types";

const USAGE_PAGE_SIZE = 20;

function toNumber(value: number | string): number {
  return value === "" ? 0 : Number(value);
}

/** 渠道管理组件 */
function ChannelManager(props: {
  channels: ModelChannelDto[];
  activeChannel: ModelChannelDto | null;
  onActivated: () => Promise<void>;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [modalOpened, setModalOpened] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditingId(null);
    setName("");
    setBaseUrl("");
    setModel("");
    setTimeoutMs(30000);
    setModalOpened(true);
  }

  function openEdit(ch: ModelChannelDto) {
    setEditingId(ch.id);
    setName(ch.name);
    setBaseUrl(ch.baseUrl);
    setModel(ch.model);
    setTimeoutMs(ch.timeoutMs);
    setModalOpened(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editingId) {
        await apiSend(`/api/settings/channels/${editingId}`, "PUT", {
          name,
          baseUrl,
          model,
          timeoutMs,
        });
      } else {
        await apiSend("/api/settings/channels", "POST", {
          name,
          baseUrl,
          model,
          timeoutMs,
        });
      }
      setModalOpened(false);
      await props.onReload();
    } catch (err) {
      props.onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate(id: string) {
    setBusy(true);
    try {
      await apiSend(`/api/settings/channels/${id}`, "POST");
      await props.onActivated();
    } catch (err) {
      props.onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("确认删除此渠道？")) return;
    setBusy(true);
    try {
      await apiSend(`/api/settings/channels/${id}`, "DELETE");
      await props.onReload();
    } catch (err) {
      props.onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginTop: "var(--sp-3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>渠道列表</h3>
          <p className="muted small" style={{ margin: "var(--sp-1) 0 0 0" }}>
            可配置多个模型渠道服务地址，并在需要时一键切换启用渠道。
          </p>
        </div>
        <Button size="xs" variant="default" onClick={openCreate} disabled={busy}>
          + 添加渠道
        </Button>
      </div>

      <TableScroll label="模型渠道列表">
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>渠道名称</th>
              <th>服务地址 (Base URL)</th>
              <th>模型名称</th>
              <th>超时</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {props.channels.map((ch) => (
              <tr key={ch.id}>
                <td>
                  <strong>{ch.name}</strong>
                </td>
                <td>
                  <code>{ch.baseUrl}</code>
                </td>
                <td>{ch.model}</td>
                <td>{ch.timeoutMs}ms</td>
                <td>
                  {ch.isActive ? (
                    <Badge color="green" variant="light">
                      当前启用
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="outline">
                      未启用
                    </Badge>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", gap: "var(--sp-1)" }}>
                    {!ch.isActive && (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => void handleActivate(ch.id)}
                        disabled={busy}
                      >
                        启用
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => openEdit(ch)}
                      disabled={busy}
                    >
                      编辑
                    </Button>
                    {!ch.isActive && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => void handleDelete(ch.id)}
                        disabled={busy}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <Modal
        opened={modalOpened}
        onClose={() => setModalOpened(false)}
        title={editingId ? "编辑渠道" : "添加渠道"}
        centered
      >
        <form className="stack" onSubmit={handleSave}>
          <TextInput
            label="渠道名称"
            placeholder="例如：TypeSafe 官方 或 自建 Laya"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <TextInput
            label="服务地址 (Base URL)"
            placeholder="例如：https://api.typesafe.ai"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
          <TextInput
            label="模型标识"
            placeholder="例如：jev-latest 或 typesafe/jev"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
          />
          <NumberInput
            label="调用超时（毫秒）"
            min={1000}
            max={120000}
            value={timeoutMs}
            onChange={(v) => setTimeoutMs(toNumber(v))}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-2)", marginTop: "var(--sp-2)" }}>
            <Button variant="default" onClick={() => setModalOpened(false)} disabled={busy}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              保存
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** 调度与基础配置表单 */
function ConnectionScheduleForm(props: {
  view: JevSettingsDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [concurrency, setConcurrency] = useState(props.view.config.concurrency);
  const [jobsPerRound, setJobsPerRound] = useState(props.view.config.jobsPerRound);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiSend<JevConfigDto>("/api/settings/jev", "PUT", {
        concurrency,
        jobsPerRound,
        version: props.view.version,
      });
      props.onSaved();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack form-narrow" onSubmit={save}>
      <div className="grid-2">
        <div className="stack">
          <NumberInput
            label="全局并发数"
            min={JE_CONCURRENCY_RANGE.min}
            max={JE_CONCURRENCY_RANGE.max}
            value={concurrency}
            onChange={(value) => setConcurrency(toNumber(value))}
          />
          <span className="muted small">
            <strong>全局并发上限 {JE_CONCURRENCY_RANGE.min}—{JE_CONCURRENCY_RANGE.max}</strong>
            （默认 {JE_CONCURRENCY_RANGE.min} = 串行）。所有入口共享，增加密钥数量不会放大并发。
          </span>
        </div>
        <div className="stack">
          <NumberInput
            label="每轮判断任务预算"
            min={JE_JOBS_PER_ROUND_RANGE.min}
            max={JE_JOBS_PER_ROUND_RANGE.max}
            value={jobsPerRound}
            onChange={(value) => setJobsPerRound(toNumber(value))}
          />
          <span className="muted small">
            每轮最多认领的任务数（默认 {JE_JOBS_PER_ROUND_RANGE.min}）。
          </span>
        </div>
      </div>
      <div className="row" style={{ marginTop: "var(--sp-2)" }}>
        <Button type="submit" loading={busy}>
          保存调度配置
        </Button>
      </div>
    </form>
  );
}

/** 判断模式与正则过滤表单 */
function StrategyForm(props: {
  view: JevSettingsDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [evaluationMode, setEvaluationMode] = useState<EvaluationModeDto>(
    props.view.config.evaluationMode,
  );
  const [regexRulesText, setRegexRulesText] = useState(
    props.view.config.regexRules.join("\n"),
  );
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiSend<JevConfigDto>("/api/settings/jev", "PUT", {
        evaluationMode,
        regexRules: regexRulesText.split("\n"),
        version: props.view.version,
      });
      props.onSaved();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack form-narrow" onSubmit={save}>
      <Fieldset id="jev-strategy" legend="后台判断模式">
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            只影响后台对<strong>之后新采集</strong>线报的自动处理；连接测试与需求试判仍直接调用，
            不会被预筛吞掉。切换模式不会回放历史线报，已有批次按当时的策略快照继续完成。
          </p>
          <Radio.Group
            value={evaluationMode}
            onChange={(next) => setEvaluationMode(next as EvaluationModeDto)}
            aria-label="后台判断模式"
          >
            <div className="stack">
              {EVALUATION_MODE_OPTIONS.map((option) => (
                <Radio
                  key={option.value}
                  value={option.value}
                  disabled={busy}
                  label={
                    <span className="stack" style={{ gap: "var(--sp-1)" }}>
                      <strong>{option.label}</strong>
                      <span className="muted small">{option.description}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </Radio.Group>

          {evaluationMode === "regex_gate" ? (
            <div className="stack" style={{ marginTop: "var(--sp-2)" }}>
              <Textarea
                label="全局正则规则（一行一条，任意命中即放行）"
                rows={6}
                value={regexRulesText}
                disabled={busy}
                spellCheck={false}
                aria-label="全局正则规则"
                placeholder={"抽纸|软抽\n湿巾|洗脸巾"}
                onChange={(event) => setRegexRulesText(event.currentTarget.value)}
              />
              <span className="muted small">
                直接写 JS 正则 source，<strong>不要首尾斜杠</strong>，固定忽略大小写与 Unicode；
                空白行忽略，相同规则去重。最多 {MAX_REGEX_RULES} 条，每条最多{" "}
                {MAX_REGEX_RULE_LENGTH} 个字符，合计不超过 16 KiB。
              </span>
            </div>
          ) : (
            <p className="muted small" style={{ margin: "var(--sp-1) 0 0 0" }}>
              已保存的全局正则规则会保留；切换到「正则预筛后逐条判断」即可查看与编辑。
            </p>
          )}
        </div>
      </Fieldset>
      <div className="row">
        <Button type="submit" loading={busy}>
          保存判断模式
        </Button>
      </div>
    </form>
  );
}

/** 费用用量展示面板 */
function JevUsagePanel(props: {
  channels: ModelChannelDto[];
  selectedChannelId: string;
  onChannelChange: (id: string) => void;
  usage: JevUsageDto | undefined;
  error: string | null;
  loading: boolean;
  page: number;
  onPage: (page: number) => void;
}) {
  const [byKeyOpened, setByKeyOpened] = useState(false);
  const [byKeyPage, setByKeyPage] = useState(0);

  if (props.loading && !props.usage) {
    return <Feedback kind="loading">正在加载用量统计…</Feedback>;
  }
  if (props.error && !props.usage) {
    return <Feedback kind="error">用量统计加载失败：{props.error}</Feedback>;
  }
  if (!props.usage) return null;

  const { summary, byKey, recent } = props.usage;
  const safeByKeyPage = clampPage(byKeyPage, byKey.length, JEV_USAGE_BY_KEY_PAGE_SIZE);
  const previewKeys = byKey.slice(0, JEV_USAGE_BY_KEY_PREVIEW);

  const channelSelectOptions = [
    { value: "", label: "全部渠道" },
    ...props.channels.map((ch) => ({
      value: ch.id,
      label: `${ch.name} (${ch.model})`,
    })),
  ];

  return (
    <div className="stack">
      <div style={{ maxWidth: 320, marginBottom: "var(--sp-2)" }}>
        <Select
          label="筛选渠道"
          placeholder="选择渠道"
          data={channelSelectOptions}
          value={props.selectedChannelId}
          onChange={(val) => props.onChannelChange(val ?? "")}
        />
      </div>

      <div className="grid-4">
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">总请求数</span>
          <span style={{ fontSize: "1.4rem", fontWeight: 600 }}>{summary.totalRequests}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">估算总费用</span>
          <span style={{ fontSize: "1.4rem", fontWeight: 600, color: "var(--color-primary)" }}>
            {summary.knownCostUsd}
          </span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">失败请求</span>
          <span style={{ fontSize: "1.4rem", fontWeight: 600 }}>{summary.failedCount}</span>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="muted small">输入 / 输出 Token</span>
          <span style={{ fontSize: "1.1rem", fontWeight: 500 }}>
            {summary.inputTokensKnown} / {summary.outputTokensKnown}
          </span>
        </div>
      </div>

      <div style={{ marginTop: "var(--sp-3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4 style={{ margin: 0 }}>各 Key 用量 (前 {JEV_USAGE_BY_KEY_PREVIEW} 个)</h4>
          {byKey.length > JEV_USAGE_BY_KEY_PREVIEW && (
            <Button size="xs" variant="subtle" onClick={() => setByKeyOpened(true)}>
              查看全部 ({byKey.length})
            </Button>
          )}
        </div>
        <TableScroll label="各 Key 用量预览">
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Key 名称</th>
                <th>请求数</th>
                <th>估算费用</th>
                <th>失败数</th>
              </tr>
            </thead>
            <tbody>
              {previewKeys.map((item) => (
                <tr key={item.keyId ?? "unknown"}>
                  <td>{item.keyLabel ?? "未记录 Key"}</td>
                  <td>{item.requestCount}</td>
                  <td>{item.knownCostUsd}</td>
                  <td>{item.failedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>

      <div style={{ marginTop: "var(--sp-3)" }}>
        <h4 style={{ margin: "0 0 var(--sp-1) 0" }}>最近调用账本</h4>
        <TableScroll label="最近调用账本">
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>时间</th>
                <th>用途</th>
                <th>Key / 服务地址</th>
                <th>状态</th>
                <th>HTTP / 耗时</th>
                <th>估算费用</th>
              </tr>
            </thead>
            <tbody>
              {recent.items.map((req) => (
                <tr key={req.id}>
                  <td>{formatTime(req.startedAt)}</td>
                  <td>{req.purposeLabel}</td>
                  <td>
                    <div>{req.keyLabel ?? "—"}</div>
                    {req.baseUrl && <div className="muted small">{req.baseUrl}</div>}
                  </td>
                  <td>
                    <StatusBadge
                      status={
                        req.status === "succeeded"
                          ? "matched"
                          : req.status === "failed"
                            ? "failed"
                            : "baseline"
                      }
                    >
                      {req.statusLabel}
                    </StatusBadge>
                  </td>
                  <td>{req.httpStatus ?? "—"}</td>
                  <td>{req.estimatedUsd ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <Pagination
          page={props.page}
          total={recent.total}
          pageSize={USAGE_PAGE_SIZE}
          onPage={props.onPage}
        />
      </div>

      <Modal
        opened={byKeyOpened}
        onClose={() => setByKeyOpened(false)}
        title="全部 Key 用量明细"
        size="lg"
      >
        <TableScroll label="全部 Key 用量明细">
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Key 名称</th>
                <th>请求数</th>
                <th>估算费用</th>
                <th>失败数</th>
              </tr>
            </thead>
            <tbody>
              {pageSlice(byKey, safeByKeyPage, JEV_USAGE_BY_KEY_PAGE_SIZE).map((item) => (
                <tr key={item.keyId ?? "unknown"}>
                  <td>{item.keyLabel ?? "未记录 Key"}</td>
                  <td>{item.requestCount}</td>
                  <td>{item.knownCostUsd}</td>
                  <td>{item.failedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <Pagination
          page={safeByKeyPage}
          total={byKey.length}
          pageSize={JEV_USAGE_BY_KEY_PAGE_SIZE}
          onPage={setByKeyPage}
        />
      </Modal>
    </div>
  );
}

/** 模型配置主页面 */
export default function ModelSettingsPage() {
  const [activeTab, setActiveTab] = useState<string | null>("connection");
  const [keysOpened, setKeysOpened] = useState(false);
  const [selectedChannelIdForKeys, setSelectedChannelIdForKeys] = useState<string>("");
  const [selectedChannelIdForUsage, setSelectedChannelIdForUsage] = useState<string>("");
  const [usagePage, setUsagePage] = useState(0);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const channelsResource = useApiResource<ModelChannelDto[]>("/api/settings/channels");
  const channels = channelsResource.data ?? [];
  const channelsLoading = channelsResource.loading;

  const settings = useApiResource<JevSettingsDto>("/api/settings/jev");
  const usage = useApiResource<JevUsageDto>(
    `/api/settings/jev/usage?page=${usagePage + 1}&pageSize=${USAGE_PAGE_SIZE}${
      selectedChannelIdForUsage ? `&channelId=${selectedChannelIdForUsage}` : ""
    }`,
  );

  async function reloadAll() {
    await Promise.all([settings.reload(), usage.reload(), channelsResource.reload()]);
  }

  function reportResult(message: string, ok = true) {
    setActionError(null);
    setNotice({ kind: ok ? "success" : "error", text: message });
  }

  const activeChannel = channels.find((c) => c.isActive) ?? null;
  const channelKeySelection = selectedChannelIdForKeys || activeChannel?.id || "";

  async function testCurrentChannel() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await apiSend<TestResultDto>("/api/settings/jev/test", "POST");
      reportResult(res.message ?? "测试完成", res.ok);
      await reloadAll();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const data = settings.data;
  if (!data && settings.loading) {
    return (
      <div className="page">
        <PageHeader title="模型配置" />
        <Feedback kind="loading">正在加载模型配置…</Feedback>
      </div>
    );
  }

  const filteredKeys = data?.keys.filter((k) => {
    if (!channelKeySelection) return true;
    return k.channelId === channelKeySelection;
  }) ?? [];

  const enabledKeys = filteredKeys.filter((k) => k.enabled).length;

  return (
    <div className="page">
      <PageHeader
        title="模型配置"
        lead="配置 LLM 模型渠道、调度参数、API 密钥与判断策略。调用密钥与费用用量按渠道隔离。"
      />

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind={notice.kind}>{notice.text}</Feedback> : null}

      <Tabs value={activeTab} onChange={setActiveTab} style={{ marginTop: "var(--sp-2)" }}>
        <Tabs.List>
          <Tabs.Tab value="connection">连接与调度</Tabs.Tab>
          <Tabs.Tab value="strategy">判断模式</Tabs.Tab>
          <Tabs.Tab value="keys">API 密钥</Tabs.Tab>
          <Tabs.Tab value="usage">费用与用量</Tabs.Tab>
          <Tabs.Tab value="dry-run">需求试判</Tabs.Tab>
        </Tabs.List>

        {/* Tab 1: 连接与调度 */}
        <Tabs.Panel value="connection" pt="md">
          <Section
            title="当前活动渠道"
            description="后台处理、连接测试与需求试判严格使用当前启用的渠道配置。"
            actions={
              <Button
                variant="default"
                size="sm"
                onClick={() => void testCurrentChannel()}
                loading={busy}
              >
                测试活动渠道连接
              </Button>
            }
          >
            {activeChannel ? (
              <div
                style={{
                  display: "flex",
                  gap: "var(--sp-4)",
                  padding: "var(--sp-3)",
                  background: "var(--surface-muted, #f8f9fa)",
                  borderRadius: "var(--radius-sm, 6px)",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <span className="muted small">渠道名称</span>
                  <div style={{ fontWeight: 600 }}>{activeChannel.name}</div>
                </div>
                <div>
                  <span className="muted small">服务地址 (Base URL)</span>
                  <div>
                    <code>{activeChannel.baseUrl}</code>
                  </div>
                </div>
                <div>
                  <span className="muted small">模型标识</span>
                  <div>{activeChannel.model}</div>
                </div>
                <div>
                  <span className="muted small">超时时间</span>
                  <div>{activeChannel.timeoutMs}ms</div>
                </div>
                <div>
                  <Badge color="green" variant="light">
                    当前启用中
                  </Badge>
                </div>
              </div>
            ) : (
              <Feedback kind="error">未找到任何启用的模型渠道，请在下方选择启用。</Feedback>
            )}

            <ChannelManager
              channels={channels}
              activeChannel={activeChannel}
              onActivated={async () => {
                reportResult("已切换启用渠道。");
                await reloadAll();
              }}
              onReload={channelsResource.reload}
              onError={setActionError}
            />
          </Section>

          {data && (
            <Section title="全局调度参数" description="设置模型调用的全局并发与批次任务上限。">
              <ConnectionScheduleForm
                key={data.version}
                view={data}
                onSaved={() => {
                  reportResult("调度配置已保存。");
                  void reloadAll();
                }}
                onError={setActionError}
              />
            </Section>
          )}
        </Tabs.Panel>

        {/* Tab 2: 判断模式 */}
        <Tabs.Panel value="strategy" pt="md">
          {data && (
            <Section title="判断模式与前置规则" description="选择后台对新线报的自动分析与正则预筛策略。">
              <StrategyForm
                key={data.version}
                view={data}
                onSaved={() => {
                  reportResult("判断模式已保存。");
                  void reloadAll();
                }}
                onError={setActionError}
              />
            </Section>
          )}
        </Tabs.Panel>

        {/* Tab 3: API 密钥 */}
        <Tabs.Panel value="keys" pt="md">
          <Section
            title="API 密钥池"
            description="按渠道隔离管理各上游服务商的 API 密钥。调度时仅从当前启用渠道所属的 Key 池中选取。"
            actions={
              <Button variant="default" size="sm" onClick={() => setKeysOpened(true)}>
                管理当前渠道密钥
              </Button>
            }
          >
            <div style={{ maxWidth: 320, marginBottom: "var(--sp-2)" }}>
              <Select
                label="所属渠道"
                placeholder="选择渠道"
                data={channels.map((ch) => ({
                  value: ch.id,
                  label: `${ch.name} (${ch.model})`,
                }))}
                value={channelKeySelection}
                onChange={(val) => setSelectedChannelIdForKeys(val ?? "")}
              />
            </div>

            {filteredKeys.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                该渠道下暂未配置 API 密钥。点击右上角「管理当前渠道密钥」添加。
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                该渠道下共 {filteredKeys.length} 个 Key · {enabledKeys} 个启用。
              </p>
            )}

            <JevKeysPanel
              channelId={channelKeySelection}
              baseUrl={channels.find((c) => c.id === channelKeySelection)?.baseUrl}
              opened={keysOpened}
              onClose={() => setKeysOpened(false)}
              keys={filteredKeys}
              loadError={settings.error}
              reload={reloadAll}
            />
          </Section>
        </Tabs.Panel>

        {/* Tab 4: 费用与用量 */}
        <Tabs.Panel value="usage" pt="md">
          <Section
            title="费用与用量统计"
            description="展示各渠道的实际调用统计与账本。金额按公布费率估算。"
          >
            <JevUsagePanel
              channels={channels}
              selectedChannelId={selectedChannelIdForUsage}
              onChannelChange={setSelectedChannelIdForUsage}
              usage={usage.data ?? undefined}
              error={usage.error}
              loading={usage.loading}
              page={usagePage}
              onPage={setUsagePage}
            />
          </Section>
        </Tabs.Panel>

        {/* Tab 5: 需求试判 */}
        <Tabs.Panel value="dry-run" pt="md">
          <DryRunPanel />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
