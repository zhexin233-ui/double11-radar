"use client";

import { useState } from "react";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import type { JevConfigDto, TestResultDto } from "@/components/api-types";

type SecretAction = "keep" | "replace" | "clear";

function JevForm(props: {
  view: JevConfigDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(props.view.config.baseUrl);
  const [model, setModel] = useState(props.view.config.model);
  const [timeoutMs, setTimeoutMs] = useState(props.view.config.timeoutMs);
  const [apiKeyAction, setApiKeyAction] = useState<SecretAction>("keep");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { baseUrl, model, timeoutMs };
      if (apiKeyAction === "clear") payload.apiKey = { clear: true };
      else if (apiKeyAction === "replace") payload.apiKey = apiKey;
      await apiSend<JevConfigDto>("/api/settings/jev", "PUT", payload);
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

      <fieldset>
        <legend>
          API 密钥（当前：
          {props.view.apiKey.unreadable
            ? "无法解密（加密密钥可能已变更）"
            : props.view.apiKey.configured
              ? `已配置 ${props.view.apiKey.masked ?? ""}`
              : "未配置"}
          ）
        </legend>
        <div className="row">
          {(["keep", "replace", "clear"] as SecretAction[]).map((action) => (
            <label key={action}>
              <input
                type="radio"
                name="apikey"
                checked={apiKeyAction === action}
                onChange={() => setApiKeyAction(action)}
              />{" "}
              {action === "keep" ? "保留原值" : action === "replace" ? "替换" : "清除"}
            </label>
          ))}
        </div>
        {apiKeyAction === "replace" ? (
          <input
            type="password"
            placeholder="新的 API 密钥"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            style={{ width: "100%" }}
          />
        ) : null}
        <p className="muted small">
          留空不会清除已保存的密钥；只有选择「清除」才会删除。
        </p>
      </fieldset>

      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存配置
        </button>
      </div>
    </form>
  );
}

export default function JevPage() {
  const { data, error, loading, reload } = useApiResource<JevConfigDto>(
    "/api/settings/jev",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiSend<TestResultDto>("/api/settings/jev/test", "POST", {});
      setNotice(
        result.ok
          ? `连接测试成功：${result.message ?? ""}`
          : `连接测试失败：${result.message ?? "未知原因"}`,
      );
      setActionError(null);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">加载失败：{error}</p>;
  if (loading || !data) return <p className="muted">正在加载…</p>;

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
          setNotice("Jev 配置已保存。");
          setActionError(null);
          void reload();
        }}
        onError={setActionError}
      />

      <div className="row">
        <button type="button" className="ghost" onClick={() => void test()} disabled={busy}>
          测试连接
        </button>
        <span className="muted small">
          测试只做单次调用，不会回放历史线报；真实语义效果需要在你的凭据环境下验证。
        </span>
      </div>
    </div>
  );
}
