"use client";

import { useState } from "react";
import {
  Button,
  Fieldset,
  Modal,
  NumberInput,
  Radio,
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
  type JevSettingsDto,
  type JevUsageByKeyDto,
  type JevUsageDto,
  type TestResultDto,
} from "@/components/api-types";

/** 最近调用分页大小（与服务端默认一致）。 */
const USAGE_PAGE_SIZE = 20;

/** NumberInput 的 onChange 可能是数字或空串；统一收窄成数字。 */
function toNumber(value: number | string): number {
  return value === "" ? 0 : Number(value);
}

/** 基础配置表单：只提交非敏感配置，密钥改由下方的密钥池管理。 */
function JevForm(props: {
  view: JevSettingsDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(props.view.config.baseUrl);
  const [model, setModel] = useState(props.view.config.model);
  const [timeoutMs, setTimeoutMs] = useState(props.view.config.timeoutMs);
  const [concurrency, setConcurrency] = useState(props.view.config.concurrency);
  const [jobsPerRound, setJobsPerRound] = useState(props.view.config.jobsPerRound);
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
        baseUrl,
        model,
        timeoutMs,
        concurrency,
        jobsPerRound,
        evaluationMode,
        // 服务端会忽略纯空白行并去重；切换模式时不清空已保存规则。
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
      <TextInput
        type="url"
        label="服务地址"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.currentTarget.value)}
        required
      />
      <TextInput
        label="模型标识"
        value={model}
        onChange={(event) => setModel(event.currentTarget.value)}
        required
      />
      <NumberInput
        label="调用超时（毫秒）"
        min={1000}
        max={120000}
        value={timeoutMs}
        onChange={(value) => setTimeoutMs(toNumber(value))}
      />

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
            <div className="stack">
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
                {MAX_REGEX_RULE_LENGTH} 个字符，合计不超过 16 KiB。匹配标题、正文及现有品类/品牌/商城/来源价格；
                规则未覆盖的线报不会调用 JEV，可能漏报。
              </span>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              已保存的全局正则规则会保留；切换到「正则预筛后逐条判断」即可查看与编辑。
            </p>
          )}
        </div>
      </Fieldset>

      <div className="grid-2">
        <div className="stack">
          <NumberInput
            label="Jev 并发数"
            min={JE_CONCURRENCY_RANGE.min}
            max={JE_CONCURRENCY_RANGE.max}
            value={concurrency}
            onChange={(value) => setConcurrency(toNumber(value))}
          />
          <span className="muted small">
            <strong>全局并发上限 {JE_CONCURRENCY_RANGE.min}—{JE_CONCURRENCY_RANGE.max}</strong>
            （默认 {JE_CONCURRENCY_RANGE.min} = 严格串行）。后台判断、连接测试与需求试判共用这一上限，
            增加密钥数量不会放大并发；同时进行的请求数越多，向 Jev 施加的压力越大。
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
            上限 {JE_JOBS_PER_ROUND_RANGE.max}，默认 3。worker 每 2 秒触发一轮，
            每轮最多领取并处理这么多条<strong>判断任务</strong>（批次初筛也算一个调度任务，
            不是批次条数）；播放展开后的成员也各自占一个任务。实际吞吐还受并发数与单次调用耗时限制。
          </span>
        </div>
      </div>

      <p className="muted small" style={{ margin: 0 }}>
        这两项保存后<strong>立即生效</strong>（worker 每轮重新读取），不需要重启容器。
        逐条/正则模式下每条线报只发一次请求、携带全部启用需求，因此增加需求不会增加请求数；
        批次模式会额外发一次整体初筛。
      </p>

      <div className="row">
        <Button type="submit" loading={busy}>
          保存配置
        </Button>
      </div>
    </form>
  );
}

/**
 * 按 Key 汇总表：预览与弹窗共用同一组件，避免两套单元格逻辑漂移。
 * `knownRequestCount === 0` 时显示「—（暂无可计价调用）」而不是 `$0.00`。
 */
function ByKeyTable(props: { rows: JevUsageByKeyDto[]; label: string }) {
  return (
    <TableScroll label={props.label} minTableWidth={900}>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>实际调用</th>
            <th>已计价</th>
            <th>未知费用</th>
            <th>失败</th>
            <th>输入 Token</th>
            <th>输出 Token</th>
            <th>已知估算费用</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.keyId ?? "unknown"}>
              <td>{row.keyLabel ?? "未关联 Key"}</td>
              <td className="small">{row.requestCount}</td>
              <td className="small">{row.requestCount - row.unknownCostCount}</td>
              <td className="small">{row.unknownCostCount}</td>
              <td className="small">{row.failedCount}</td>
              <td className="small">{row.inputTokens.toLocaleString()}</td>
              <td className="small">{row.outputTokens.toLocaleString()}</td>
              <td className="small">
                {row.knownRequestCount === 0
                  ? "—（暂无可计价调用）"
                  : `$${row.knownCostUsd}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/**
 * 「按 Key 汇总」页面表现：前 N 行预览 + 「查看全部」弹窗分页。
 *
 * `rows` 是服务端按 `knownCostNanos DESC, requestCount DESC` 排好序的完整数组；
 * 预览是纯派生，不复制进 state。
 */
function JevUsageByKey(props: { rows: JevUsageByKeyDto[] }) {
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState(0);
  const { rows } = props;

  if (rows.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        还没有按 Key 的调用记录。
      </p>
    );
  }

  const total = rows.length;
  const safePage = clampPage(page, total, JEV_USAGE_BY_KEY_PAGE_SIZE);
  const preview = rows.slice(0, JEV_USAGE_BY_KEY_PREVIEW);

  return (
    <>
      <ByKeyTable
        rows={preview}
        label={`按 Key 调用汇总（前 ${JEV_USAGE_BY_KEY_PREVIEW} 行预览）`}
      />
      {total > JEV_USAGE_BY_KEY_PREVIEW ? (
        <div className="row">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              setPage(0);
              setOpened(true);
            }}
          >
            查看全部 {total} 个 Key
          </Button>
          <span className="muted small">
            按已知估算费用从高到低排序，这里只显示前 {JEV_USAGE_BY_KEY_PREVIEW} 行。
          </span>
        </div>
      ) : null}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={`按 Key 调用汇总（共 ${total} 个）`}
        size={1000}
        centered
      >
        <div className="stack">
          <ByKeyTable
            rows={pageSlice(rows, safePage, JEV_USAGE_BY_KEY_PAGE_SIZE)}
            label="按 Key 调用汇总（全部）"
          />
          <Pagination
            page={safePage}
            total={total}
            pageSize={JEV_USAGE_BY_KEY_PAGE_SIZE}
            onPage={setPage}
            unit="个 Key"
          />
        </div>
      </Modal>
    </>
  );
}

/** 费用与用量面板：金额为公布费率下的估算，未知用量单独计数。 */
function JevUsagePanel(props: {
  usage: JevUsageDto | null;
  error: string | null;
  loading: boolean;
  page: number;
  onPage: (page: number) => void;
}) {
  const { usage } = props;

  return (
    <div className="stack">
      {props.error ? <Feedback kind="error">{props.error}</Feedback> : null}
      {props.loading && !usage ? <Feedback kind="loading">正在加载…</Feedback> : null}

      {usage ? (
        <>
          <dl className="facts">
            <dt>统计开始时间</dt>
            <dd>
              {usage.summary.statsStartedAt
                ? formatTime(usage.summary.statsStartedAt)
                : "尚无调用记录"}
            </dd>
            <dt>已知累计估算费用</dt>
            <dd>
              {usage.summary.knownRequestCount === 0
                ? /* 没有任何可计价调用时不能显示成 $0.00，否则会被读成「免费」 */
                  "—（暂无可计价调用）"
                : `$${usage.summary.knownCostUsd}`}
              {usage.summary.unknownCostCount > 0
                ? `（另有 ${usage.summary.unknownCostCount} 次调用费用未知，未计入）`
                : ""}
            </dd>
            <dt>实际调用数</dt>
            <dd>{usage.summary.totalRequests}</dd>
            <dt>已计价调用数</dt>
            <dd>{usage.summary.knownRequestCount}</dd>
            <dt>未知费用调用数</dt>
            <dd>{usage.summary.unknownCostCount}</dd>
            <dt>失败次数</dt>
            <dd>{usage.summary.failedCount}</dd>
            <dt>进行中</dt>
            <dd>{usage.summary.pendingCount}</dd>
            <dt>输入 Token（已知用量）</dt>
            <dd>{usage.summary.inputTokensKnown.toLocaleString()}</dd>
            <dt>输出 Token（已知用量）</dt>
            <dd>{usage.summary.outputTokensKnown.toLocaleString()}</dd>
          </dl>

          <h3>按 Key 汇总</h3>
          <JevUsageByKey rows={usage.byKey} />

          <h3>最近调用</h3>
          {usage.recent.total === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              尚无调用记录。
            </p>
          ) : (
            <>
              {usage.recent.items.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  本页没有调用记录。
                </p>
              ) : (
                <TableScroll label="最近调用记录" minTableWidth={900}>
                  <table>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>来源</th>
                        <th>模型</th>
                        <th>状态</th>
                        <th>Key</th>
                        <th>用量（输入 / 输出）</th>
                        <th>估算费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.recent.items.map((request) => (
                        <tr key={request.id}>
                          <td className="small">{formatTime(request.startedAt)}</td>
                          <td className="small">{request.purposeLabel}</td>
                          <td className="small">
                            {request.responseModel ?? request.requestedModel}
                          </td>
                          <td className="small">
                            <StatusBadge status={request.status}>
                              {request.statusLabel}
                            </StatusBadge>
                          </td>
                          <td className="small">{request.keyLabel ?? "—"}</td>
                          <td className="small">
                            {request.inputTokens ?? "未知"} / {request.outputTokens ?? "未知"}
                          </td>
                          <td className="small">
                            {request.estimatedUsd !== null
                              ? `$${request.estimatedUsd}`
                              : (request.unknownReason ?? "费用未知")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              <Pagination
                page={props.page}
                total={usage.recent.total}
                pageSize={USAGE_PAGE_SIZE}
                onPage={props.onPage}
                unit="次调用"
              />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

export default function JevPage() {
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keysOpened, setKeysOpened] = useState(false);
  const [usagePage, setUsagePage] = useState(0);

  const settings = useApiResource<JevSettingsDto>("/api/settings/jev");
  const usage = useApiResource<JevUsageDto>(
    `/api/settings/jev/usage?limit=${USAGE_PAGE_SIZE}&offset=${usagePage * USAGE_PAGE_SIZE}`,
  );

  // 调用记录被清理导致页码越界时在渲染期收敛（不用 set-state-in-effect，见 bulletins 页）。
  const usageTotal = usage.data?.recent.total ?? null;
  if (usageTotal !== null) {
    const clamped = clampPage(usagePage, usageTotal, USAGE_PAGE_SIZE);
    if (clamped !== usagePage) setUsagePage(clamped);
  }
  const safeUsagePage =
    usageTotal === null ? usagePage : clampPage(usagePage, usageTotal, USAGE_PAGE_SIZE);

  async function reloadAll() {
    await Promise.all([settings.reload(), usage.reload()]);
  }

  function reportResult(message: string, kind: "success" | "error" = "success") {
    setNotice({ kind, text: message });
    setActionError(null);
  }

  async function testPool() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiSend<TestResultDto>("/api/settings/jev/test", "POST", {});
      const ok = result.ok;
      reportResult(
        ok
          ? `连接测试成功：${result.message ?? ""}`
          : `连接测试失败：${result.message ?? "未知原因"}`,
        ok ? "success" : "error",
      );
      await reloadAll();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const data = settings.data;

  if (settings.error && !data) {
    return (
      <div className="page">
        <PageHeader title="Jev 配置" />
        <Feedback kind="error">加载失败：{settings.error}</Feedback>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="Jev 配置" />
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  const enabledKeys = data.keys.filter((key) => key.enabled).length;

  return (
    <div className="page">
      <PageHeader
        title="Jev 配置"
        lead="使用 TypeSafe Jev 原生 System One 接口（POST /v1/systemone），只返回结构化 Choice 判断，不生成自由文本。API 密钥只在服务端加密保存与使用。"
      />

      <nav className="anchor-nav" aria-label="Jev 配置分区">
        <a href="#jev-connection">连接与调度</a>
        <a href="#jev-strategy">判断模式</a>
        <a href="#jev-keys">API 密钥</a>
        <a href="#jev-usage">费用与用量</a>
        <a href="#jev-dry-run">需求试判</a>
      </nav>

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind={notice.kind}>{notice.text}</Feedback> : null}
      {settings.error ? (
        <Feedback kind="error">
          刷新失败：{settings.error}（下方为上次成功数据）
        </Feedback>
      ) : null}

      <Section
        id="jev-connection"
        className="anchor-target"
        title="连接与调度"
        description={
          <>
            当前已知状态：{enabledKeys} 个启用密钥 / 共 {data.keys.length} 个。
            连接测试从密钥池调度一次<strong>真实调用</strong>（会计入费用统计），不会回放历史线报；
            真实语义效果需要在你的凭据环境下验证。
          </>
        }
        actions={
          <Button variant="default" size="sm" onClick={() => void testPool()} loading={busy}>
            测试连接
          </Button>
        }
      >
        <JevForm
          key={data.version}
          view={data}
          onSaved={() => {
            reportResult("Jev 配置已保存。");
            void reloadAll();
          }}
          onError={setActionError}
        />
      </Section>

      <Section
        id="jev-keys"
        className="anchor-target"
        title="API 密钥"
        description={
          <>
            可配置多个密钥并发处理新线报，总在途请求数仍受上面的全局并发上限约束。
            同一 Key 连续 {JE_KEY_FAILURE_THRESHOLD} 次实际请求失败会自动禁用，成功一次清零；
            禁用（含手动停用）后需手动恢复或替换密钥，失败计数与禁用状态重启后保留。
            密钥只在服务端加密使用，网页只显示掩码。
          </>
        }
        actions={
          <Button variant="default" size="sm" onClick={() => setKeysOpened(true)}>
            管理密钥
          </Button>
        }
      >
        {data.keys.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            还没有配置 Jev 密钥。添加后，后台判断、连接测试与需求试判都会从密钥池调度。
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            共 {data.keys.length} 个 Key · {enabledKeys} 个启用。密钥较多时不再把长表铺在页面上，
            改为在弹窗内分页查看与编辑。
          </p>
        )}
      </Section>

      <JevKeysPanel
        opened={keysOpened}
        onClose={() => setKeysOpened(false)}
        keys={data.keys}
        loadError={settings.error}
        reload={reloadAll}
      />

      <Section
        id="jev-usage"
        className="anchor-target"
        title="费用与用量"
        description={
          <>
            金额<strong>按官方公布费率估算，不是服务商实付账单</strong>，也不包含未核实的缓存折扣或定制合同价格。
            统计只覆盖应用启用本功能之后的实际调用，不能由历史判断记录倒推既往账单；
            每次实际重试、连接测试与需求试判都会各计一次调用。
          </>
        }
      >
        <JevUsagePanel
          usage={usage.data}
          error={usage.error}
          loading={usage.loading}
          page={safeUsagePage}
          onPage={setUsagePage}
        />
      </Section>

      <DryRunPanel />
    </div>
  );
}
