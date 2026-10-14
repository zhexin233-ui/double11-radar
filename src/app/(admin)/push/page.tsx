"use client";

import { useState } from "react";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import type {
  NotifyConfigDto,
  SecretStateDto,
  TestResultDto,
} from "@/components/api-types";

type SecretAction = "keep" | "replace" | "clear";

function SecretField(props: {
  label: string;
  state: SecretStateDto;
  action: SecretAction;
  value: string;
  onAction: (action: SecretAction) => void;
  onValue: (value: string) => void;
  placeholder: string;
}) {
  return (
    <fieldset>
      <legend>
        {props.label}（当前：
        {props.state.unreadable
          ? "无法解密（加密密钥可能已变更）"
          : props.state.configured
            ? `已配置 ${props.state.masked ?? ""}`
            : "未配置"}）
      </legend>
      <div className="row">
        {(["keep", "replace", "clear"] as SecretAction[]).map((action) => (
          <label key={action}>
            <input
              type="radio"
              name={props.label}
              checked={props.action === action}
              onChange={() => props.onAction(action)}
            />{" "}
            {action === "keep" ? "保留原值" : action === "replace" ? "替换" : "清除"}
          </label>
        ))}
      </div>
      {props.action === "replace" ? (
        <input
          type="password"
          placeholder={props.placeholder}
          value={props.value}
          onChange={(event) => props.onValue(event.target.value)}
          style={{ width: "100%" }}
        />
      ) : null}
    </fieldset>
  );
}

function PushForm(props: {
  view: NotifyConfigDto;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [barkEnabled, setBarkEnabled] = useState(props.view.config.bark.enabled);
  const [barkServer, setBarkServer] = useState(props.view.config.bark.serverUrl);
  const [deviceKeyAction, setDeviceKeyAction] = useState<SecretAction>("keep");
  const [deviceKey, setDeviceKey] = useState("");

  const [feishuEnabled, setFeishuEnabled] = useState(props.view.config.feishu.enabled);
  const [keywordPrefix, setKeywordPrefix] = useState(props.view.config.feishu.keywordPrefix);
  const [signingEnabled, setSigningEnabled] = useState(
    props.view.config.feishu.signingEnabled,
  );
  const [webhookAction, setWebhookAction] = useState<SecretAction>("keep");
  const [webhook, setWebhook] = useState("");
  const [signingAction, setSigningAction] = useState<SecretAction>("keep");
  const [signingSecret, setSigningSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function test(channel: "bark" | "feishu") {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiSend<TestResultDto>("/api/settings/notify/test", "POST", {
        channel,
      });
      const label = channel === "bark" ? "Bark" : "飞书";
      setNotice(
        result.ok
          ? `${label} 测试发送成功（接口返回成功，不代表设备已读）。`
          : `${label} 测试发送失败：${result.error ?? "未知原因"}${
              result.bizCode ? `（业务码 ${result.bizCode}）` : ""
            }`,
      );
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const bark: Record<string, unknown> = { enabled: barkEnabled, serverUrl: barkServer };
      if (deviceKeyAction === "clear") bark.deviceKey = { clear: true };
      else if (deviceKeyAction === "replace") bark.deviceKey = deviceKey;

      const feishu: Record<string, unknown> = {
        enabled: feishuEnabled,
        keywordPrefix,
        signingEnabled,
      };
      if (webhookAction === "clear") feishu.webhook = { clear: true };
      else if (webhookAction === "replace") feishu.webhook = webhook;
      if (signingAction === "clear") feishu.signingSecret = { clear: true };
      else if (signingAction === "replace") feishu.signingSecret = signingSecret;

      await apiSend<NotifyConfigDto>("/api/settings/notify", "PUT", { bark, feishu });
      props.onSaved();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      <section className="card stack">
        <h2>Bark</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={barkEnabled}
            onChange={(event) => setBarkEnabled(event.target.checked)}
          />
          启用 Bark 推送
        </label>
        <label>
          服务地址
          <input
            type="url"
            value={barkServer}
            onChange={(event) => setBarkServer(event.target.value)}
            style={{ width: "100%" }}
          />
        </label>
        <SecretField
          label="设备 Key"
          state={props.view.bark.deviceKey}
          action={deviceKeyAction}
          value={deviceKey}
          onAction={setDeviceKeyAction}
          onValue={setDeviceKey}
          placeholder="Bark 设备 Key"
        />
        <button type="button" className="ghost" disabled={busy} onClick={() => void test("bark")}>
          测试 Bark
        </button>
      </section>

      <section className="card stack">
        <h2>飞书群机器人</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={feishuEnabled}
            onChange={(event) => setFeishuEnabled(event.target.checked)}
          />
          启用飞书推送
        </label>
        <SecretField
          label="Webhook 地址"
          state={props.view.feishu.webhook}
          action={webhookAction}
          value={webhook}
          onAction={setWebhookAction}
          onValue={setWebhook}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
        />
        <label className="row">
          <input
            type="checkbox"
            checked={signingEnabled}
            onChange={(event) => setSigningEnabled(event.target.checked)}
          />
          开启签名校验（需同时配置签名密钥）
        </label>
        <SecretField
          label="签名密钥"
          state={props.view.feishu.signingSecret}
          action={signingAction}
          value={signingSecret}
          onAction={setSigningAction}
          onValue={setSigningSecret}
          placeholder="飞书签名密钥"
        />
        <label>
          关键词前缀（可选，会写入通知标题，用于通过关键词校验）
          <input
            value={keywordPrefix}
            onChange={(event) => setKeywordPrefix(event.target.value)}
            style={{ width: "100%" }}
            maxLength={100}
          />
        </label>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void test("feishu")}
        >
          测试飞书
        </button>
      </section>

      {notice ? <div className="notice">{notice}</div> : null}

      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存配置
        </button>
      </div>
    </form>
  );
}

export default function PushPage() {
  const { data, error, loading, reload } = useApiResource<NotifyConfigDto>(
    "/api/settings/notify",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (error) return <p className="error">加载失败：{error}</p>;
  if (loading || !data) return <p className="muted">正在加载…</p>;

  return (
    <div className="stack">
      <h1>推送渠道</h1>
      <p className="muted small">
        首版 Bark 固定一个设备、飞书固定一个群机器人。两者独立启停，命中的线报会发送到所有已启用渠道；
        一个渠道失败只重试该渠道，已成功渠道不会重复发送。
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {saved ? <div className="notice">推送渠道配置已保存。</div> : null}

      <PushForm
        key={data.version}
        view={data}
        onSaved={() => {
          setSaved(true);
          setActionError(null);
          void reload();
        }}
        onError={setActionError}
      />
    </div>
  );
}
