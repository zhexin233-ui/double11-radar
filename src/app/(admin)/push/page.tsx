"use client";

import { useState } from "react";
import {
  Button,
  Fieldset,
  PasswordInput,
  Radio,
  Switch,
  TextInput,
} from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import type {
  NotifyConfigDto,
  SecretStateDto,
  TestResultDto,
} from "@/components/api-types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { Feedback } from "@/components/ui/Feedback";

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
    <Fieldset
      legend={
        <>
          {props.label}（当前：
          {props.state.unreadable
            ? "无法解密（加密密钥可能已变更）"
            : props.state.configured
              ? `已配置 ${props.state.masked ?? ""}`
              : "未配置"}）
        </>
      }
    >
      <div className="stack">
        <Radio.Group
          value={props.action}
          onChange={(next) => props.onAction(next as SecretAction)}
          aria-label={`${props.label}处理方式`}
        >
          <div className="row">
            <Radio value="keep" label="保留原值" />
            <Radio value="replace" label="替换" />
            <Radio value="clear" label="清除" />
          </div>
        </Radio.Group>
        {props.action === "replace" ? (
          <PasswordInput
            placeholder={props.placeholder}
            aria-label={props.placeholder}
            value={props.value}
            onChange={(event) => props.onValue(event.currentTarget.value)}
          />
        ) : null}
      </div>
    </Fieldset>
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
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

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
          ? {
              kind: "success",
              text: `${label} 测试发送成功（接口返回成功，不代表设备已读）。`,
            }
          : {
              kind: "error",
              text: `${label} 测试发送失败：${result.error ?? "未知原因"}${
                result.bizCode ? `（业务码 ${result.bizCode}）` : ""
              }`,
            },
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
      <div className="grid-2">
        <Section title="Bark" headingLevel={2}>
          <div className="stack">
            <Switch
              checked={barkEnabled}
              onChange={(event) => setBarkEnabled(event.currentTarget.checked)}
              label="启用 Bark 推送"
            />
            <TextInput
              type="url"
              label="服务地址"
              value={barkServer}
              onChange={(event) => setBarkServer(event.currentTarget.value)}
            />
            <SecretField
              label="设备 Key"
              state={props.view.bark.deviceKey}
              action={deviceKeyAction}
              value={deviceKey}
              onAction={setDeviceKeyAction}
              onValue={setDeviceKey}
              placeholder="Bark 设备 Key"
            />
            <div className="row">
              <Button
                type="button"
                variant="default"
                size="sm"
                loading={busy}
                onClick={() => void test("bark")}
              >
                测试 Bark
              </Button>
            </div>
          </div>
        </Section>

        <Section title="飞书群机器人" headingLevel={2}>
          <div className="stack">
            <Switch
              checked={feishuEnabled}
              onChange={(event) => setFeishuEnabled(event.currentTarget.checked)}
              label="启用飞书推送"
            />
            <SecretField
              label="Webhook 地址"
              state={props.view.feishu.webhook}
              action={webhookAction}
              value={webhook}
              onAction={setWebhookAction}
              onValue={setWebhook}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            />
            <Switch
              checked={signingEnabled}
              onChange={(event) => setSigningEnabled(event.currentTarget.checked)}
              label="开启签名校验（需同时配置签名密钥）"
            />
            <SecretField
              label="签名密钥"
              state={props.view.feishu.signingSecret}
              action={signingAction}
              value={signingSecret}
              onAction={setSigningAction}
              onValue={setSigningSecret}
              placeholder="飞书签名密钥"
            />
            <TextInput
              label="关键词前缀（可选，会写入通知标题，用于通过关键词校验）"
              value={keywordPrefix}
              onChange={(event) => setKeywordPrefix(event.currentTarget.value)}
              maxLength={100}
            />
            <div className="row">
              <Button
                type="button"
                variant="default"
                size="sm"
                loading={busy}
                onClick={() => void test("feishu")}
              >
                测试飞书
              </Button>
            </div>
          </div>
        </Section>
      </div>

      {notice ? <Feedback kind={notice.kind}>{notice.text}</Feedback> : null}

      <div className="row">
        <Button type="submit" loading={busy}>
          保存配置
        </Button>
      </div>
    </form>
  );
}

export default function PushPage() {
  const { data, error, reload } = useApiResource<NotifyConfigDto>(
    "/api/settings/notify",
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (error && !data) {
    return (
      <div className="page">
        <PageHeader title="推送渠道" />
        <Feedback kind="error">加载失败：{error}</Feedback>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="推送渠道" />
        <Feedback kind="loading">正在加载…</Feedback>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="推送渠道"
        lead="首版 Bark 固定一个设备、飞书固定一个群机器人。两者独立启停，命中的线报会发送到所有已启用渠道；一个渠道失败只重试该渠道，已成功渠道不会重复发送。"
      />

      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {saved ? <Feedback kind="success">推送渠道配置已保存。</Feedback> : null}
      {error ? <Feedback kind="error">刷新失败：{error}（下方为上次成功数据）</Feedback> : null}

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
