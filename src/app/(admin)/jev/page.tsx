"use client";

import { useState } from "react";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import { DryRunPanel } from "@/components/DryRunPanel";
import {
  JE_CONCURRENCY_RANGE,
  JE_JOBS_PER_ROUND_RANGE,
  JE_KEY_FAILURE_THRESHOLD,
  type JevConfigDto,
  type JevKeyDto,
  type JevSettingsDto,
  type JevUsageDto,
  type SecretStateDto,
  type TestResultDto,
} from "@/components/api-types";

type SecretAction = "keep" | "replace" | "clear";

/** 最近调用分页大小（与服务端默认一致）。 */
const USAGE_PAGE_SIZE = 20;

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function secretStateLabel(state: SecretStateDto): string {
  if (state.unreadable) return "无法解密（加密密钥可能已变更）";
  if (!state.configured) return "未配置";
  return state.masked ? `已配置 ${state.masked}` : "已配置";
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
      });
      props.onSaved();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <label>
        服务地址
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          style={{ width: "100%" }}
          required
        />
      </label>
      <label>
        模型标识
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          style={{ width: "100%" }}
          required
        />
      </label>
      <label>
        调用超时（毫秒）
        <input
          type="number"
          min={1000}
          max={120000}
          value={timeoutMs}
          onChange={(event) => setTimeoutMs(Number(event.target.value))}
        />
      </label>

      <div className="grid-2">
        <label>
          Jev 并发数
          <input
            type="number"
            min={JE_CONCURRENCY_RANGE.min}
            max={JE_CONCURRENCY_RANGE.max}
            value={concurrency}
            onChange={(event) => setConcurrency(Number(event.target.value))}
          />
          <span className="muted small">
            <strong>全局并发上限 {JE_CONCURRENCY_RANGE.min}—{JE_CONCURRENCY_RANGE.max}</strong>
            （默认 {JE_CONCURRENCY_RANGE.min} = 严格串行）。后台判断、连接测试与需求试判共用这一上限，
            增加密钥数量不会放大并发；同时进行的请求数越多，向 Jev 施加的压力越大。
          </span>
        </label>
        <label>
          每轮任务数
          <input
            type="number"
            min={JE_JOBS_PER_ROUND_RANGE.min}
            max={JE_JOBS_PER_ROUND_RANGE.max}
            value={jobsPerRound}
            onChange={(event) => setJobsPerRound(Number(event.target.value))}
          />
          <span className="muted small">
            上限 {JE_JOBS_PER_ROUND_RANGE.max}，默认 3。worker 每 2 秒触发一轮，
            每轮最多领取并处理这么多条线报；实际吞吐还受并发数与单次调用耗时限制。
          </span>
        </label>
      </div>

      <p className="muted small">
        这两项保存后<strong>立即生效</strong>（worker 每轮重新读取），不需要重启容器。
        一个 Jev 请求会携带全部启用需求，因此增加需求不会增加请求数。
      </p>

      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存配置
        </button>
      </div>
    </form>
  );
}

/** 新增密钥表单：只把明文交给服务端加密保存，成功后清空输入。 */
function JevKeyAddForm(props: {
  onDone: (notice: string) => void;
  onError: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim() || !apiKey.trim()) return;
    setBusy(true);
    try {
      await apiSend<JevKeyDto>("/api/settings/jev/keys", "POST", {
        label: label.trim(),
        apiKey: apiKey.trim(),
      });
      setLabel("");
      setApiKey("");
      props.onDone("已添加 Jev 密钥。");
      await props.reload();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="row" onSubmit={submit}>
      <input
        placeholder="Key 名称，例如：主账号"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={100}
        disabled={busy}
        style={{ flex: "1 1 160px" }}
      />
      <input
        type="password"
        placeholder="API 密钥（只在服务端加密保存）"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        maxLength={500}
        autoComplete="off"
        disabled={busy}
        style={{ flex: "2 1 260px" }}
      />
      <button type="submit" className="primary" disabled={busy || !label.trim() || !apiKey.trim()}>
        添加密钥
      </button>
    </form>
  );
}

/** 单个密钥的展示与操作（重命名、替换/清除、启停恢复、测试、删除）。 */
function JevKeyRow(props: {
  item: JevKeyDto;
  onDone: (notice: string) => void;
  onError: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const { item } = props;
  const [secretAction, setSecretAction] = useState<SecretAction>("keep");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const base = `/api/settings/jev/keys/${item.id}`;

  async function guard(action: () => Promise<string>) {
    setBusy(true);
    try {
      const message = await action();
      setSecretAction("keep");
      setSecret("");
      props.onDone(message);
      await props.reload();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function rename(next: string) {
    void guard(async () => {
      await apiSend(base, "PATCH", { label: next });
      return `已重命名为「${next}」。`;
    });
  }

  function applySecret() {
    if (secretAction === "clear") {
      if (
        !window.confirm(
          `清除「${item.label}」的密钥？清除后会停用该 Key，需要替换密钥后才能再次启用。`,
        )
      ) {
        return;
      }
      void guard(async () => {
        await apiSend(base, "PATCH", { apiKey: { clear: true } });
        return `已清除「${item.label}」的密钥并停用该 Key。`;
      });
      return;
    }
    if (secretAction === "replace") {
      const value = secret.trim();
      if (!value) return;
      void guard(async () => {
        await apiSend(base, "PATCH", { apiKey: value });
        return `已替换「${item.label}」的密钥，失败计数清零并进入新 generation。`;
      });
    }
  }

  function toggleEnabled() {
    const next = !item.enabled;
    if (
      !next &&
      !window.confirm(`停用「${item.label}」？停用后不再分配新请求，可在需要时手动恢复。`)
    ) {
      return;
    }
    void guard(async () => {
      await apiSend(base, "PATCH", { enabled: next });
      return next ? `已恢复「${item.label}」，失败计数清零。` : `已停用「${item.label}」。`;
    });
  }

  function testKey() {
    void guard(async () => {
      const result = await apiSend<TestResultDto>("/api/settings/jev/test", "POST", {
        keyId: item.id,
      });
      if (!result.ok) {
        throw new Error(`「${item.label}」连接测试失败：${result.message ?? "未知原因"}`);
      }
      return `「${item.label}」连接测试成功：${result.message ?? ""}`;
    });
  }

  function removeKey() {
    if (
      !window.confirm(
        `删除 Key「${item.label}」？密钥密文会被清除，历史调用账本保留非敏感快照。`,
      )
    ) {
      return;
    }
    void guard(async () => {
      await apiSend(base, "DELETE");
      return `已删除 Key「${item.label}」。`;
    });
  }

  return (
    <tr>
      <td>
        <input
          key={`${item.id}:${item.updatedAt}:label`}
          defaultValue={item.label}
          disabled={busy}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next && next !== item.label) rename(next);
            else if (!next) event.target.value = item.label;
          }}
        />
      </td>
      <td className="small">{secretStateLabel(item.secretState)}</td>
      <td>
        <span className={`badge ${item.enabled ? "matched" : "baseline"}`}>
          {item.enabled ? "已启用" : "已停用"}
        </span>
      </td>
      <td className="small">
        {item.consecutiveFailures} / {JE_KEY_FAILURE_THRESHOLD}
      </td>
      <td className="small">
        {item.disabledReason ? <div>{item.disabledReason}</div> : null}
        {item.lastError ? <div className="muted">{item.lastError}</div> : null}
        {!item.disabledReason && !item.lastError ? "—" : null}
      </td>
      <td className="small">{formatTime(item.lastUsedAt)}</td>
      <td>
        <div className="stack">
          <fieldset>
            <legend className="small">密钥</legend>
            <div className="row small">
              {(["keep", "replace", "clear"] as SecretAction[]).map((action) => (
                <label key={action}>
                  <input
                    type="radio"
                    name={`secret-${item.id}`}
                    checked={secretAction === action}
                    disabled={busy}
                    onChange={() => setSecretAction(action)}
                  />{" "}
                  {action === "keep" ? "保留" : action === "replace" ? "替换" : "清除"}
                </label>
              ))}
            </div>
            {secretAction === "replace" ? (
              <input
                type="password"
                placeholder="新的 API 密钥"
                value={secret}
                disabled={busy}
                onChange={(event) => setSecret(event.target.value)}
                style={{ width: "100%" }}
              />
            ) : null}
            {secretAction !== "keep" ? (
              <button
                type="button"
                className="primary"
                disabled={busy || (secretAction === "replace" && !secret.trim())}
                onClick={applySecret}
              >
                应用密钥变更
              </button>
            ) : null}
          </fieldset>
          <div className="row">
            <button type="button" className="ghost" disabled={busy} onClick={toggleEnabled}>
              {item.enabled ? "停用" : "恢复"}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={testKey}>
              测试
            </button>
            <button type="button" className="ghost danger" disabled={busy} onClick={removeKey}>
              删除
            </button>
          </div>
        </div>
      </td>
    </tr>
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
    <section className="card stack">
      <div>
        <h2 style={{ marginBottom: 4 }}>费用与用量</h2>
        <p className="muted small">
          金额<strong>按官方公布费率估算，不是服务商实付账单</strong>，也不包含未核实的缓存折扣或定制合同价格。
          统计只覆盖应用启用本功能之后的实际调用，不能由历史判断记录倒推既往账单；
          每次实际重试、连接测试与需求试判都会各计一次调用。
        </p>
      </div>

      {props.error ? <p className="error">{props.error}</p> : null}
      {props.loading && !usage ? <p className="muted">正在加载…</p> : null}

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
          {usage.byKey.length === 0 ? (
            <p className="muted">还没有按 Key 的调用记录。</p>
          ) : (
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
                {usage.byKey.map((row) => (
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
          )}

          <h3>最近调用</h3>
          {usage.recent.items.length === 0 ? (
            <p className="muted">尚无调用记录。</p>
          ) : (
            <>
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
                        <span className={`badge ${request.status === "failed" ? "failed" : ""}`}>
                          {request.statusLabel}
                        </span>
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
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted small">共 {usage.recent.total} 次调用</span>
                <span className="row">
                  <button
                    type="button"
                    className="ghost"
                    disabled={props.page === 0}
                    onClick={() => props.onPage(Math.max(0, props.page - 1))}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={(props.page + 1) * USAGE_PAGE_SIZE >= usage.recent.total}
                    onClick={() => props.onPage(props.page + 1)}
                  >
                    下一页
                  </button>
                </span>
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

export default function JevPage() {
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usagePage, setUsagePage] = useState(0);

  const settings = useApiResource<JevSettingsDto>("/api/settings/jev");
  const usage = useApiResource<JevUsageDto>(
    `/api/settings/jev/usage?limit=${USAGE_PAGE_SIZE}&offset=${usagePage * USAGE_PAGE_SIZE}`,
  );

  async function reloadAll() {
    await Promise.all([settings.reload(), usage.reload()]);
  }

  function reportResult(message: string) {
    setNotice(message);
    setActionError(null);
  }

  async function testPool() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiSend<TestResultDto>("/api/settings/jev/test", "POST", {});
      reportResult(
        result.ok
          ? `连接测试成功：${result.message ?? ""}`
          : `连接测试失败：${result.message ?? "未知原因"}`,
      );
      await reloadAll();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const data = settings.data;

  if (settings.error) return <p className="error">加载失败：{settings.error}</p>;
  if (settings.loading || !data) return <p className="muted">正在加载…</p>;

  return (
    <div className="stack">
      <h1>Jev 配置</h1>
      <p className="muted small">
        使用 TypeSafe Jev 原生 System One 接口（POST /v1/systemone），只返回结构化 Choice
        判断，不生成自由文本。API 密钥只在服务端加密保存与使用。
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <JevForm
        key={data.version}
        view={data}
        onSaved={() => {
          reportResult("Jev 配置已保存。");
          void reloadAll();
        }}
        onError={setActionError}
      />

      <section className="card stack">
        <div>
          <h2 style={{ marginBottom: 4 }}>API 密钥</h2>
          <p className="muted small">
            可配置多个密钥并发处理新线报，总在途请求数仍受上面的全局并发上限约束。
            同一 Key 连续 {JE_KEY_FAILURE_THRESHOLD} 次实际请求失败会自动禁用，成功一次清零；
            禁用（含手动停用）后需手动恢复或替换密钥，失败计数与禁用状态重启后保留。
            密钥只在服务端加密使用，网页只显示掩码。
          </p>
        </div>

        <JevKeyAddForm onDone={reportResult} onError={setActionError} reload={reloadAll} />

        {data.keys.length === 0 ? (
          <p className="muted">
            还没有配置 Jev 密钥。添加后，后台判断、连接测试与需求试判都会从密钥池调度。
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>密钥</th>
                <th>状态</th>
                <th>连续失败</th>
                <th>禁用原因 / 最近错误</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.keys.map((item) => (
                <JevKeyRow
                  key={`${item.id}:${item.updatedAt}`}
                  item={item}
                  onDone={reportResult}
                  onError={setActionError}
                  reload={reloadAll}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="row">
        <button type="button" className="ghost" onClick={() => void testPool()} disabled={busy}>
          测试连接
        </button>
        <span className="muted small">
          从密钥池调度一次真实调用（会进入费用统计），不会回放历史线报；真实语义效果需要在你的凭据环境下验证。
        </span>
      </div>

      <JevUsagePanel
        usage={usage.data}
        error={usage.error}
        loading={usage.loading}
        page={usagePage}
        onPage={setUsagePage}
      />

      <DryRunPanel />
    </div>
  );
}
