"use client";

import { useState } from "react";
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
import { Stage2SettingsPanel } from "@/components/Stage2SettingsPanel";
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
  JEV_USAGE_BY_KEY_PAGE_SIZE,
  JEV_USAGE_BY_KEY_PREVIEW,
  MAX_REGEX_RULE_LENGTH,
  MAX_REGEX_RULES,
  RATE_SOURCE_LABELS,
  USAGE_STAGE_OPTIONS,
  type EvaluationModeDto,
  type JevConfigDto,
  type JevSettingsDto,
  type JevUsageDto,
  type JevUsageRequestDto,
  type ModelChannelDto,
  type TestResultDto,
  type UsageStageScopeDto,
} from "@/components/api-types";

const USAGE_PAGE_SIZE = 20;

function toNumber(value: number | string): number {
  return value === "" ? 0 : Number(value);
}

/** 渠道管理组件 */
function ChannelManager(props: {
  channels: ModelChannelDto[];
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
  const [pendingDelete, setPendingDelete] = useState<ModelChannelDto | null>(
    null,
  );
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

  async function confirmDelete(channel: ModelChannelDto) {
    setBusy(true);
    try {
      await apiSend(`/api/settings/channels/${channel.id}`, "DELETE");
      setPendingDelete(null);
      await props.onReload();
    } catch (err) {
      props.onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginTop: "var(--sp-5)" }}>
      <div className="section-head" style={{ marginBottom: 0 }}>
        <div>
          <h3>渠道列表</h3>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            可配置多个模型渠道服务地址，并在需要时一键切换启用渠道。
          </p>
        </div>
        <Button size="sm" variant="default" onClick={openCreate} disabled={busy}>
          添加渠道
        </Button>
      </div>

      <TableScroll label="模型渠道列表">
        <table>
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
                <td className="mono">{ch.model}</td>
                <td className="mono">{ch.timeoutMs}ms</td>
                <td>
                  <StatusBadge status={ch.isActive ? "matched" : "baseline"}>
                    {ch.isActive ? "当前启用" : "未启用"}
                  </StatusBadge>
                </td>
                <td>
                  <div className="row" style={{ gap: "var(--sp-1)" }}>
                    {!ch.isActive ? (
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => void handleActivate(ch.id)}
                        disabled={busy}
                      >
                        启用
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => openEdit(ch)}
                      disabled={busy}
                    >
                      编辑
                    </Button>
                    {!ch.isActive ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => setPendingDelete(ch)}
                        disabled={busy}
                      >
                        删除
                      </Button>
                    ) : null}
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
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              onClick={() => setModalOpened(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              保存
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        opened={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="删除模型渠道"
        centered
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            确认删除渠道「{pendingDelete?.name}」？删除后不会影响历史调用账本记录。
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
                if (pendingDelete) void confirmDelete(pendingDelete);
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

/** 调度与基础配置表单 */
function ConnectionScheduleForm(props: {
  view: JevSettingsDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [concurrency, setConcurrency] = useState(props.view.config.concurrency);
  const [jobsPerRound, setJobsPerRound] = useState(
    props.view.config.jobsPerRound,
  );
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
        <div className="stack-sm">
          <NumberInput
            label="全局并发数"
            min={JE_CONCURRENCY_RANGE.min}
            max={JE_CONCURRENCY_RANGE.max}
            value={concurrency}
            onChange={(value) => setConcurrency(toNumber(value))}
          />
          <span className="muted small">
            <strong>
              全局并发上限 {JE_CONCURRENCY_RANGE.min}—{JE_CONCURRENCY_RANGE.max}
            </strong>
            （默认 {JE_CONCURRENCY_RANGE.min} = 串行）。所有入口共享，增加密钥数量不会放大并发。
          </span>
        </div>
        <div className="stack-sm">
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
      <div className="row">
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
                    <span className="stack-sm" style={{ gap: 2 }}>
                      <strong>{option.label}</strong>
                      <span className="muted small">{option.description}</span>
                    </span>
                  }
                />
              ))}
            </div>
          </Radio.Group>

          {evaluationMode === "regex_gate" ? (
            <div className="stack-sm">
              <Textarea
                label="全局正则规则（一行一条，任意命中即放行）"
                rows={6}
                value={regexRulesText}
                disabled={busy}
                spellCheck={false}
                aria-label="全局正则规则"
                placeholder={"抽纸|软抽\n湿巾|洗脸巾"}
                styles={{ input: { fontFamily: "var(--font-mono)" } }}
                onChange={(event) =>
                  setRegexRulesText(event.currentTarget.value)
                }
              />
              <span className="muted small">
                直接写 JS 正则 source，<strong>不要首尾斜杠</strong>，固定忽略大小写与
                Unicode； 空白行忽略，相同规则去重。最多 {MAX_REGEX_RULES}{" "}
                条，每条最多 {MAX_REGEX_RULE_LENGTH} 个字符，合计不超过 16 KiB。
              </span>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
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

function formatRateSourceSummary(req: JevUsageRequestDto): string {
  if (req.stage === "stage1") {
    return req.costStatus === "known" ? RATE_SOURCE_LABELS.official : "未知";
  }
  if (req.inputRateSource === req.outputRateSource) {
    return RATE_SOURCE_LABELS[req.inputRateSource];
  }
  const shortLabel = (s: JevUsageRequestDto["inputRateSource"]) =>
    s === "manual" ? "手动" : s === "openrouter" ? "目录" : "未知";
  return `入:${shortLabel(req.inputRateSource)} / 出:${shortLabel(req.outputRateSource)}`;
}

/** 费用用量展示面板 */
function JevUsagePanel(props: {
  channels: ModelChannelDto[];
  stage: UsageStageScopeDto;
  onStageChange: (stage: UsageStageScopeDto) => void;
  selectedChannelId: string;
  onChannelChange: (id: string) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
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

  const { summary, byKey, byModel, availableModels, recent } = props.usage;
  const safeByKeyPage = clampPage(
    byKeyPage,
    byKey.length,
    JEV_USAGE_BY_KEY_PAGE_SIZE,
  );
  const previewKeys = byKey.slice(0, JEV_USAGE_BY_KEY_PREVIEW);

  const channelSelectOptions = [
    { value: "", label: "全部渠道" },
    ...props.channels.map((ch) => ({
      value: ch.id,
      label: `${ch.name} (${ch.model})`,
    })),
  ];

  const modelSelectOptions = [
    { value: "", label: "全部模型" },
    ...availableModels.map((m) => ({ value: m, label: m })),
  ];

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--sp-3)" }}>
        <div style={{ minWidth: 220 }}>
          <Select
            label="核验级别"
            data={USAGE_STAGE_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            value={props.stage}
            onChange={(val) =>
              props.onStageChange((val as UsageStageScopeDto) || "all")
            }
          />
        </div>
        <div style={{ minWidth: 240 }}>
          <Select
            label="筛选模型"
            placeholder="全部模型"
            searchable
            data={modelSelectOptions}
            value={props.selectedModel}
            onChange={(val) => props.onModelChange(val ?? "")}
          />
        </div>
        {props.stage === "stage1" ? (
          <div style={{ minWidth: 240 }}>
            <Select
              label="筛选一级渠道"
              placeholder="全部渠道"
              data={channelSelectOptions}
              value={props.selectedChannelId}
              onChange={(val) => props.onChannelChange(val ?? "")}
            />
          </div>
        ) : null}
      </div>

      {props.stage !== "stage1" ? (
        <p className="muted small" style={{ margin: 0 }}>
          二级核验逐次调用统计自本功能启用时开始
          {props.usage.stage2StatsStartedAt
            ? `（最早记录：${formatTime(props.usage.stage2StatsStartedAt)}）`
            : "（暂未产生二级调用记录）"}
          ；OpenRouter 目录价为参考估算，不含缓存折扣或发票差异。
        </p>
      ) : null}

      <div className="stats">
        <div className="stat-cell">
          <div className="stat-label">总请求数</div>
          <div className="stat-value">{summary.totalRequests}</div>
          {summary.pendingCount > 0 ? (
            <div className="muted small">进行中 {summary.pendingCount} 次</div>
          ) : null}
        </div>
        <div className="stat-cell">
          <div className="stat-label">已知估算总费用</div>
          <div className="stat-value mono">${summary.knownCostUsd}</div>
          <div className="muted small">
            已计价 {summary.knownRequestCount} 次 · 费用未知{" "}
            {summary.unknownCostCount} 次
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">失败请求</div>
          <div
            className={
              summary.failedCount > 0 ? "stat-value error" : "stat-value"
            }
          >
            {summary.failedCount}
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">已知输入 / 输出 Token</div>
          <div
            className="stat-value mono"
            style={{ fontSize: "clamp(1.05rem, 1.6vw, 1.35rem)" }}
          >
            {summary.inputTokensKnown} / {summary.outputTokensKnown}
          </div>
        </div>
      </div>

      <div className="stack-sm">
        <h3>按模型汇总</h3>
        {byModel.length === 0 ? (
          <p className="empty">暂无按模型统计记录。</p>
        ) : (
          <TableScroll label="按模型用量汇总" minTableWidth={640}>
            <table>
              <thead>
                <tr>
                  <th>级别</th>
                  <th>模型</th>
                  <th>请求数</th>
                  <th>已计价 / 未知</th>
                  <th>输入 / 输出 Token</th>
                  <th>已知估算费用</th>
                  <th>失败数</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((item) => (
                  <tr key={`${item.stage}:${item.model}`}>
                    <td>
                      <Badge
                        size="xs"
                        variant="light"
                        color={item.stage === "stage2" ? "indigo" : "gray"}
                      >
                        {item.stageLabel}
                      </Badge>
                    </td>
                    <td className="mono">{item.model}</td>
                    <td className="mono">{item.requestCount}</td>
                    <td className="mono">
                      {item.knownRequestCount} / {item.unknownCostCount}
                    </td>
                    <td className="mono">
                      {item.inputTokens} / {item.outputTokens}
                    </td>
                    <td className="mono">
                      {item.knownRequestCount > 0
                        ? `$${item.knownCostUsd}`
                        : "—"}
                    </td>
                    <td className={item.failedCount > 0 ? "mono error" : "mono"}>
                      {item.failedCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>

      {props.stage === "stage1" ? (
        <div className="stack-sm">
          <div className="section-head" style={{ marginBottom: 0 }}>
            <h3>一级各 Key 用量（前 {JEV_USAGE_BY_KEY_PREVIEW} 个）</h3>
            {byKey.length > JEV_USAGE_BY_KEY_PREVIEW ? (
              <Button
                size="xs"
                variant="default"
                onClick={() => setByKeyOpened(true)}
              >
                查看全部 ({byKey.length})
              </Button>
            ) : null}
          </div>
          {previewKeys.length === 0 ? (
            <p className="empty">暂无各 Key 用量记录。</p>
          ) : (
            <TableScroll label="各 Key 用量预览">
              <table>
                <thead>
                  <tr>
                    <th>Key 名称</th>
                    <th>请求数</th>
                    <th>已知估算费用</th>
                    <th>费用未知</th>
                    <th>失败数</th>
                  </tr>
                </thead>
                <tbody>
                  {previewKeys.map((item) => (
                    <tr key={item.keyId ?? "unknown"}>
                      <td>{item.keyLabel ?? "未记录 Key"}</td>
                      <td className="mono">{item.requestCount}</td>
                      <td className="mono">
                        {item.knownRequestCount > 0
                          ? `$${item.knownCostUsd}`
                          : "—"}
                      </td>
                      <td className="mono">{item.unknownCostCount}</td>
                      <td
                        className={item.failedCount > 0 ? "mono error" : "mono"}
                      >
                        {item.failedCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </div>
      ) : null}

      <div className="stack-sm">
        <h3>最近调用账本</h3>
        {recent.items.length === 0 ? (
          <p className="empty">暂无调用账本记录。</p>
        ) : (
          <>
            <TableScroll label="最近调用账本" minTableWidth={860}>
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>级别</th>
                    <th>用途</th>
                    <th>模型 / 来源</th>
                    <th>状态</th>
                    <th>Token（入 / 出）</th>
                    <th>费用来源</th>
                    <th>估算费用</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.items.map((req) => (
                    <tr key={`${req.stage}:${req.id}`}>
                      <td className="small mono">
                        {formatTime(req.startedAt)}
                      </td>
                      <td>
                        <Badge
                          size="xs"
                          variant="light"
                          color={req.stage === "stage2" ? "indigo" : "gray"}
                        >
                          {req.stageLabel}
                        </Badge>
                      </td>
                      <td>{req.purposeLabel}</td>
                      <td>
                        <div className="mono small">{req.effectiveModel}</div>
                        {req.stage === "stage1" ? (
                          <div className="muted small">
                            {req.keyLabel ?? "—"}
                            {req.baseUrl ? ` · ${req.baseUrl}` : ""}
                          </div>
                        ) : (
                          <div className="muted small mono">
                            {req.providerOrigin ?? "—"}
                          </div>
                        )}
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
                        {req.httpStatus !== null ? (
                          <span className="muted small mono" style={{ marginLeft: 6 }}>
                            HTTP {req.httpStatus}
                          </span>
                        ) : null}
                        {req.errorMessage ? (
                          <div className="error small">{req.errorMessage}</div>
                        ) : null}
                      </td>
                      <td className="mono small">
                        {req.inputTokens ?? "—"} / {req.outputTokens ?? "—"}
                      </td>
                      <td className="small">
                        {formatRateSourceSummary(req)}
                      </td>
                      <td className="mono small">
                        {req.status === "in_flight" ? (
                          "—"
                        ) : req.costStatus === "known" &&
                          req.estimatedUsd !== null ? (
                          `$${req.estimatedUsd}`
                        ) : (
                          <div>
                            <span className="muted">费用未知</span>
                            {req.unknownReason ? (
                              <div className="muted small">
                                {req.unknownReason}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </td>
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
              unit="次调用"
            />
          </>
        )}
      </div>

      <Modal
        opened={byKeyOpened}
        onClose={() => setByKeyOpened(false)}
        title="全部一级 Key 用量明细"
        size="lg"
        centered
      >
        <div className="stack">
          <TableScroll label="全部 Key 用量明细">
            <table>
              <thead>
                <tr>
                  <th>Key 名称</th>
                  <th>请求数</th>
                  <th>已知估算费用</th>
                  <th>费用未知</th>
                  <th>失败数</th>
                </tr>
              </thead>
              <tbody>
                {pageSlice(
                  byKey,
                  safeByKeyPage,
                  JEV_USAGE_BY_KEY_PAGE_SIZE,
                ).map((item) => (
                  <tr key={item.keyId ?? "unknown"}>
                    <td>{item.keyLabel ?? "未记录 Key"}</td>
                    <td className="mono">{item.requestCount}</td>
                    <td className="mono">
                      {item.knownRequestCount > 0
                        ? `$${item.knownCostUsd}`
                        : "—"}
                    </td>
                    <td className="mono">{item.unknownCostCount}</td>
                    <td className={item.failedCount > 0 ? "mono error" : "mono"}>
                      {item.failedCount}
                    </td>
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
            unit="个 Key"
          />
        </div>
      </Modal>
    </div>
  );
}

/** 模型配置主页面 */
export default function ModelSettingsPage() {
  const [activeTab, setActiveTab] = useState<string | null>("connection");
  const [keysOpened, setKeysOpened] = useState(false);
  const [selectedChannelIdForKeys, setSelectedChannelIdForKeys] =
    useState<string>("");
  const [usageStage, setUsageStage] = useState<UsageStageScopeDto>("all");
  const [selectedChannelIdForUsage, setSelectedChannelIdForUsage] =
    useState<string>("");
  const [selectedModelForUsage, setSelectedModelForUsage] =
    useState<string>("");
  const [usagePage, setUsagePage] = useState(0);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const channelsResource = useApiResource<ModelChannelDto[]>(
    "/api/settings/channels",
  );
  const channels = channelsResource.data ?? [];

  const settings = useApiResource<JevSettingsDto>("/api/settings/jev");

  const usageParams = new URLSearchParams({
    stage: usageStage,
    limit: String(USAGE_PAGE_SIZE),
    offset: String(usagePage * USAGE_PAGE_SIZE),
  });
  if (usageStage === "stage1" && selectedChannelIdForUsage) {
    usageParams.set("channelId", selectedChannelIdForUsage);
  }
  if (selectedModelForUsage) {
    usageParams.set("model", selectedModelForUsage);
  }

  const usage = useApiResource<JevUsageDto>(
    `/api/settings/jev/usage?${usageParams.toString()}`,
  );

  function handleUsageStageChange(nextStage: UsageStageScopeDto) {
    setUsageStage(nextStage);
    setUsagePage(0);
    setSelectedModelForUsage("");
    if (nextStage !== "stage1") {
      setSelectedChannelIdForUsage("");
    }
  }

  function handleUsageChannelChange(nextChannelId: string) {
    setSelectedChannelIdForUsage(nextChannelId);
    setUsagePage(0);
  }

  function handleUsageModelChange(nextModel: string) {
    setSelectedModelForUsage(nextModel);
    setUsagePage(0);
  }

  async function reloadAll() {
    await Promise.all([
      settings.reload(),
      usage.reload(),
      channelsResource.reload(),
    ]);
  }

  function reportResult(message: string, ok = true) {
    setActionError(null);
    setNotice({ kind: ok ? "success" : "error", text: message });
  }

  const activeChannel = channels.find((c) => c.isActive) ?? null;
  const channelKeySelection =
    selectedChannelIdForKeys || activeChannel?.id || "";

  async function testCurrentChannel() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await apiSend<TestResultDto>(
        "/api/settings/jev/test",
        "POST",
      );
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

  const filteredKeys =
    data?.keys.filter((k) => {
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

      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Tab value="connection">连接与调度</Tabs.Tab>
          <Tabs.Tab value="strategy">判断模式</Tabs.Tab>
          <Tabs.Tab value="keys">API 密钥</Tabs.Tab>
          <Tabs.Tab value="usage">费用与用量</Tabs.Tab>
          <Tabs.Tab value="dry-run">需求试判</Tabs.Tab>
          <Tabs.Tab value="stage2">二级核验与工具</Tabs.Tab>
        </Tabs.List>

        {/* Tab 1: 连接与调度 */}
        <Tabs.Panel value="connection" pt="lg">
          <div className="stack" style={{ gap: "var(--sp-6)" }}>
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
                <div className="meta-strip">
                  <div className="meta-item">
                    <span className="meta-item-label">渠道名称</span>
                    <span className="meta-item-value">{activeChannel.name}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-item-label">服务地址</span>
                    <span className="meta-item-value">
                      <code>{activeChannel.baseUrl}</code>
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-item-label">模型标识</span>
                    <span className="meta-item-value mono">
                      {activeChannel.model}
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-item-label">超时时间</span>
                    <span className="meta-item-value mono">
                      {activeChannel.timeoutMs}ms
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-item-label">状态</span>
                    <div>
                      <StatusBadge status="matched">当前启用中</StatusBadge>
                    </div>
                  </div>
                </div>
              ) : (
                <Feedback kind="error">
                  未找到任何启用的模型渠道，请在下方选择启用。
                </Feedback>
              )}

              <ChannelManager
                channels={channels}
                onActivated={async () => {
                  reportResult("已切换启用渠道。");
                  await reloadAll();
                }}
                onReload={channelsResource.reload}
                onError={setActionError}
              />
            </Section>

            {data ? (
              <Section
                title="全局调度参数"
                description="设置模型调用的全局并发与批次任务上限。"
                alt
              >
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
            ) : null}
          </div>
        </Tabs.Panel>

        {/* Tab 2: 判断模式 */}
        <Tabs.Panel value="strategy" pt="lg">
          {data ? (
            <Section
              title="判断模式与前置规则"
              description="选择后台对新线报的自动分析与正则预筛策略。"
              alt
            >
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
          ) : null}
        </Tabs.Panel>

        {/* Tab 3: API 密钥 */}
        <Tabs.Panel value="keys" pt="lg">
          <Section
            title="API 密钥池"
            description="按渠道隔离管理各上游服务商的 API 密钥。调度时仅从当前启用渠道所属的 Key 池中选取。"
            alt
            actions={
              <Button
                variant="default"
                size="sm"
                onClick={() => setKeysOpened(true)}
              >
                管理当前渠道密钥
              </Button>
            }
          >
            <div className="stack">
              <div style={{ maxWidth: 320 }}>
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
                <p className="muted small" style={{ margin: 0 }}>
                  该渠道下暂未配置 API 密钥。点击右上角「管理当前渠道密钥」添加。
                </p>
              ) : (
                <p className="muted small mono" style={{ margin: 0 }}>
                  该渠道下共 {filteredKeys.length} 个 Key · {enabledKeys} 个启用。
                </p>
              )}
            </div>

            <JevKeysPanel
              channelId={channelKeySelection}
              baseUrl={
                channels.find((c) => c.id === channelKeySelection)?.baseUrl
              }
              opened={keysOpened}
              onClose={() => setKeysOpened(false)}
              keys={filteredKeys}
              loadError={settings.error}
              reload={reloadAll}
            />
          </Section>
        </Tabs.Panel>

        {/* Tab 4: 费用与用量 */}
        <Tabs.Panel value="usage" pt="lg">
          <Section
            title="费用与用量统计"
            description="统一查看一级（Jev / Laya）与二级深度核验的实际调用账本。金额按公布费率、手动单价或 OpenRouter 目录参考价估算。"
          >
            <JevUsagePanel
              channels={channels}
              stage={usageStage}
              onStageChange={handleUsageStageChange}
              selectedChannelId={selectedChannelIdForUsage}
              onChannelChange={handleUsageChannelChange}
              selectedModel={selectedModelForUsage}
              onModelChange={handleUsageModelChange}
              usage={usage.data ?? undefined}
              error={usage.error}
              loading={usage.loading}
              page={usagePage}
              onPage={setUsagePage}
            />
          </Section>
        </Tabs.Panel>

        {/* Tab 5: 需求试判 */}
        <Tabs.Panel value="dry-run" pt="lg">
          <DryRunPanel />
        </Tabs.Panel>

        <Tabs.Panel value="stage2" pt="lg">
          <Stage2SettingsPanel />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
