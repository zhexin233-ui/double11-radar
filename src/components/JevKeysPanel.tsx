"use client";

import { useState } from "react";
import {
  Button,
  Fieldset,
  Modal,
  Switch,
  NumberInput,
  PasswordInput,
  Radio,
  TextInput,
} from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { TableScroll } from "@/components/ui/TableScroll";
import { Pagination } from "@/components/ui/Pagination";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";
import { clampPage, pageSlice } from "@/components/pagination-model";
import { formatTime } from "@/components/format";
import {
  JE_KEY_FAILURE_THRESHOLD,
  JEV_KEYS_PAGE_SIZE,
  type BatchDeleteJevKeysResultDto,
  type JevKeyDto,
  type SecretStateDto,
  type TestResultDto,
} from "@/components/api-types";

type SecretAction = "keep" | "replace" | "clear";
type KeyConfirmKind = "clear" | "disable" | "delete";

interface Notice {
  kind: "success" | "error";
  text: string;
}

/** 单 Key 破坏性操作与批量删除禁用 Key 共用一个确认弹窗。 */
type PendingConfirm =
  | { kind: KeyConfirmKind; key: JevKeyDto }
  | { kind: "purge-disabled"; keys: JevKeyDto[] };

/** Radio.Group 的值是 string；只接受三个已知选项，避免在 JSX 里用 `as` 断言。 */
function toSecretAction(value: string): SecretAction {
  return value === "replace" || value === "clear" ? value : "keep";
}

function secretStateLabel(state: SecretStateDto): string {
  if (state.unreadable) return "无法解密（加密密钥可能已变更）";
  if (!state.configured) return "未配置";
  return state.masked ? `已配置 ${state.masked}` : "已配置";
}

function enabledBadge(enabled: boolean) {
  return (
    <StatusBadge status={enabled ? "matched" : "baseline"}>
      {enabled ? "已启用" : "已停用"}
    </StatusBadge>
  );
}

/**
 * 弹窗内反馈：密钥操作的结果不能只写到页面顶部——弹窗打开时会被遮罩挡住。
 * 三个 Modal body 里各渲染一次，保证用户当前能看到的那一层总有结果。
 */
function PanelNotice(props: { notice: Notice | null; loadError?: string | null }) {
  return (
    <>
      {props.loadError ? (
        <Feedback kind="error">
          刷新失败：{props.loadError}（下方为上次成功数据）
        </Feedback>
      ) : null}
      {props.notice ? (
        <Feedback kind={props.notice.kind}>{props.notice.text}</Feedback>
      ) : null}
    </>
  );
}


function validMinutes(value: number | string): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1440;
}

function AutoReenableControls(props: {
  enabled: boolean; minutes: number | string; busy: boolean;
  onEnabled: (value: boolean) => void; onMinutes: (value: number | string) => void;
}) {
  return <Fieldset legend="自动重新启用" style={{ flex: "1 1 100%", minWidth: 0 }}>
    <div className="stack">
      <Switch label="连续失败自动停用后，等待指定时间重新启用" checked={props.enabled}
        onChange={(event) => props.onEnabled(event.currentTarget.checked)} disabled={props.busy} />
      <NumberInput label="等待分钟数" value={props.minutes} onChange={props.onMinutes}
        min={1} max={1440} allowDecimal={false} clampBehavior="none"
        disabled={props.busy || !props.enabled}
        error={!validMinutes(props.minutes) ? "请输入 1～1440 的整数" : undefined} />
      <p className="small muted" style={{ margin: 0 }}>从自动停用时刻计时；修改间隔按原停用时刻重算。重新启用不会验证密钥可用性，仍遵守限流冷却。手动停用、替换或清除密钥会取消当前计划。</p>
    </div>
  </Fieldset>;
}

/** 新增密钥表单：只把明文交给服务端加密保存，成功后清空输入。 */
function JevKeyAddForm(props: {
  channelId?: string | null;
  baseUrl?: string;
  onDone: (notice: string) => void;
  onError: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [minutes, setMinutes] = useState<number | string>(5);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim() || !apiKey.trim() || !validMinutes(minutes)) return;
    setBusy(true);
    try {
      await apiSend<JevKeyDto>("/api/settings/jev/keys", "POST", {
        label: label.trim(),
        apiKey: apiKey.trim(),
        autoReenableEnabled: autoEnabled,
        autoReenableMinutes: minutes,
        channelId: props.channelId ?? null,
        baseUrl: props.baseUrl ?? "",
      });
      setLabel("");
      setApiKey("");
      setAutoEnabled(false);
      setMinutes(5);
      props.onDone("已添加密钥。");
      await props.reload();
    } catch (caught) {
      props.onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="row" onSubmit={submit}>
      <TextInput
        placeholder="Key 名称，例如：主账号"
        aria-label="Key 名称"
        value={label}
        onChange={(event) => setLabel(event.currentTarget.value)}
        maxLength={100}
        disabled={busy}
        style={{ flex: "1 1 160px" }}
      />
      <PasswordInput
        placeholder="API 密钥（只在服务端加密保存）"
        aria-label="API 密钥"
        value={apiKey}
        onChange={(event) => setApiKey(event.currentTarget.value)}
        maxLength={500}
        autoComplete="off"
        disabled={busy}
        style={{ flex: "2 1 260px" }}
      />
      <AutoReenableControls enabled={autoEnabled} minutes={minutes} busy={busy}
        onEnabled={setAutoEnabled} onMinutes={setMinutes} />
      <Button
        type="submit"
        loading={busy}
        disabled={!label.trim() || !apiKey.trim() || !validMinutes(minutes)}
        style={{ alignSelf: "flex-start" }}
      >
        添加密钥
      </Button>
    </form>
  );
}

/** 只读密钥表：展示态与单元格语义与旧行内实现一致，操作只剩「编辑」。 */
function JevKeysTable(props: { rows: JevKeyDto[]; onEdit: (id: string) => void }) {
  return (
    <TableScroll label="Jev API 密钥列表" minTableWidth={1100}>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>密钥</th>
            <th>状态</th>
            <th>自动重新启用</th>
            <th>连续失败</th>
            <th>禁用原因 / 最近错误</th>
            <th>最近使用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((item) => (
            <tr key={item.id}>
              <td>{item.label}</td>
              <td className="small">{secretStateLabel(item.secretState)}</td>
              <td>{enabledBadge(item.enabled)}</td>
              <td className="small">
                {item.autoReenableEnabled ? `等待 ${item.autoReenableMinutes} 分钟` : "关闭"}
                {item.autoReenableAt ? <div>待重新启用：{formatTime(item.autoReenableAt)}</div> : null}
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
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  aria-label={`编辑「${item.label}」`}
                  onClick={() => props.onEdit(item.id)}
                >
                  编辑
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 管理弹窗 body：持有页码；关闭弹窗即卸载，重开自动回到第 1 页。 */
function KeysModalBody(props: {
  channelId?: string | null;
  baseUrl?: string;
  keys: JevKeyDto[];
  notice: Notice | null;
  loadError?: string | null;
  onEdit: (id: string) => void;
  onRequestPurge: (keys: JevKeyDto[]) => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  reload: () => Promise<void>;
}) {
  const [page, setPage] = useState(0);
  const total = props.keys.length;
  const enabledCount = props.keys.filter((key) => key.enabled).length;
  const disabledKeys = props.keys.filter((key) => !key.enabled);
  const safePage = clampPage(page, total, JEV_KEYS_PAGE_SIZE);

  return (
    <div className="stack">
      <PanelNotice notice={props.notice} loadError={props.loadError} />
      <div className="toolbar">
        <p className="muted small" style={{ margin: 0 }}>
          共 {total} 个 Key · {enabledCount} 个启用 · {disabledKeys.length} 个禁用。
        </p>
        <Button
          type="button"
          variant="subtle"
          color="red"
          size="sm"
          disabled={disabledKeys.length === 0}
          aria-label={`批量删除禁用的 Key（当前 ${disabledKeys.length} 个）`}
          onClick={() => props.onRequestPurge(disabledKeys)}
        >
          批量删除禁用的 Key（{disabledKeys.length}）
        </Button>
      </div>
      <JevKeyAddForm
        channelId={props.channelId}
        baseUrl={props.baseUrl}
        onDone={props.onDone}
        onError={props.onError}
        reload={props.reload}
      />
      {total === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          还没有配置 Jev 密钥。添加后，后台判断、连接测试与需求试判都会从密钥池调度。
        </p>
      ) : (
        <>
          <JevKeysTable
            rows={pageSlice(props.keys, safePage, JEV_KEYS_PAGE_SIZE)}
            onEdit={props.onEdit}
          />
          <Pagination
            page={safePage}
            total={total}
            pageSize={JEV_KEYS_PAGE_SIZE}
            onPage={setPage}
            unit="个 Key"
          />
        </>
      )}
    </div>
  );
}

/**
 * 编辑密钥弹窗 body：保留旧行内的全部能力（重命名 / 密钥变更 / 启停 / 测试 / 删除）。
 *
 * 非破坏性写入（重命名、替换密钥、连接测试）由本组件的 `guard` 直接提交；
 * 清除 / 停用 / 删除一律通过 `onRequestConfirm` 走父级的确认弹窗，不再用浏览器原生确认框。
 */
function KeyEditForm(props: {
  item: JevKeyDto;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  onRequestConfirm: (kind: KeyConfirmKind, key: JevKeyDto) => void;
  reload: () => Promise<void>;
}) {
  const { item } = props;
  const [secretAction, setSecretAction] = useState<SecretAction>("keep");
  const [secret, setSecret] = useState("");
  const [autoEnabled, setAutoEnabled] = useState(item.autoReenableEnabled);
  const [minutes, setMinutes] = useState<number | string>(item.autoReenableMinutes);
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
      props.onRequestConfirm("clear", item);
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
    if (item.enabled) {
      props.onRequestConfirm("disable", item);
      return;
    }
    void guard(async () => {
      await apiSend(base, "PATCH", { enabled: true });
      return `已恢复「${item.label}」，失败计数清零。`;
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
    props.onRequestConfirm("delete", item);
  }

  return (
    <div className="stack">
      <dl className="facts">
        <dt>密钥状态</dt>
        <dd>{secretStateLabel(item.secretState)}</dd>
        <dt>启用状态</dt>
        <dd>{enabledBadge(item.enabled)}</dd>
        <dt>连续失败</dt>
        <dd>
          {item.consecutiveFailures} / {JE_KEY_FAILURE_THRESHOLD}
        </dd>
        <dt>禁用原因 / 最近错误</dt>
        <dd>
          {item.disabledReason ? <div>{item.disabledReason}</div> : null}
          {item.lastError ? <div className="muted">{item.lastError}</div> : null}
          {!item.disabledReason && !item.lastError ? "—" : null}
        </dd>
        <dt>自动重新启用</dt>
        <dd>{item.autoReenableEnabled ? `等待 ${item.autoReenableMinutes} 分钟` : "关闭"}
          {item.autoReenableAt ? <div>待重新启用：{formatTime(item.autoReenableAt)}（与限流冷却独立）</div> : null}</dd>
        <dt>最近使用</dt>
        <dd>{formatTime(item.lastUsedAt)}</dd>
        <dt>创建时间</dt>
        <dd>{formatTime(item.createdAt)}</dd>
        <dt>更新时间</dt>
        <dd>{formatTime(item.updatedAt)}</dd>
      </dl>

      <TextInput
        defaultValue={item.label}
        label="名称"
        aria-label="密钥名称"
        size="sm"
        disabled={busy}
        onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          if (next && next !== item.label) rename(next);
          else if (!next) event.currentTarget.value = item.label;
        }}
      />

      <AutoReenableControls enabled={autoEnabled} minutes={minutes} busy={busy}
        onEnabled={setAutoEnabled} onMinutes={setMinutes} />
      <Button type="button" variant="default" size="sm" disabled={busy || !validMinutes(minutes)}
        onClick={() => { void guard(async () => {
          await apiSend(base, "PATCH", { autoReenableEnabled: autoEnabled, autoReenableMinutes: minutes });
          return "自动重新启用设置已保存。";
        }); }} style={{ alignSelf: "flex-start" }}>保存自动重新启用设置</Button>

      <Fieldset legend="密钥">
        <div className="stack">
          <Radio.Group
            value={secretAction}
            onChange={(next) => setSecretAction(toSecretAction(next))}
            aria-label={`${item.label}密钥处理方式`}
          >
            <div className="row small">
              <Radio value="keep" label="保留" disabled={busy} />
              <Radio value="replace" label="替换" disabled={busy} />
              <Radio value="clear" label="清除" disabled={busy} />
            </div>
          </Radio.Group>
          {secretAction === "replace" ? (
            <PasswordInput
              placeholder="新的 API 密钥"
              aria-label="新的 API 密钥"
              value={secret}
              disabled={busy}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
          ) : null}
          {secretAction !== "keep" ? (
            <Button
              type="button"
              size="sm"
              loading={busy}
              disabled={secretAction === "replace" && !secret.trim()}
              onClick={applySecret}
              style={{ alignSelf: "flex-start" }}
            >
              应用密钥变更
            </Button>
          ) : null}
        </div>
      </Fieldset>

      <div className="row">
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy}
          onClick={toggleEnabled}
        >
          {item.enabled ? "停用" : "恢复"}
        </Button>
        {!item.enabled && item.autoDisabledAt ? <Button type="button" variant="default" size="sm"
          disabled={busy} onClick={() => props.onRequestConfirm("disable", item)}>
          手动停用并取消当前计划
        </Button> : null}
        <Button type="button" variant="default" size="sm" disabled={busy} onClick={testKey}>
          测试
        </Button>
        <Button
          type="button"
          variant="subtle"
          color="red"
          size="sm"
          disabled={busy}
          onClick={removeKey}
        >
          删除
        </Button>
      </div>
    </div>
  );
}

/** 确认弹窗文案（既有三种单 Key 破坏性操作的措辞逐字不变）。 */
function confirmText(pending: PendingConfirm): string {
  switch (pending.kind) {
    case "clear":
      return `清除「${pending.key.label}」的密钥？清除后会停用该 Key，需要替换密钥后才能再次启用。`;
    case "disable":
      return `停用「${pending.key.label}」？停用后不再分配新请求，并取消当前自动重新启用计划，可在需要时手动恢复。`;
    case "delete":
      return `删除 Key「${pending.key.label}」？密钥密文会被清除，历史调用账本保留非敏感快照。`;
    case "purge-disabled":
      return `批量删除 ${pending.keys.length} 个禁用的 Key？密钥密文会被清除，历史调用账本保留非敏感快照。删除后不可恢复，需要重新添加密钥。`;
  }
}

/** 确认弹窗中列出待删除的 Key 名称：最多 5 个，其余以「等 N 个」收尾。 */
function purgeKeyNames(keys: JevKeyDto[]): string {
  const names = keys
    .slice(0, 5)
    .map((key) => key.label)
    .join("、");
  return keys.length > 5 ? `${names} 等 ${keys.length} 个` : names;
}

/**
 * 密钥池管理：三个弹窗（管理 / 编辑 / 确认）+ 新增表单 + 只读分页表。
 *
 * `keys` 由页面 `useApiResource` 持有并下传，本组件不复制进 state；
 * 编辑对象每渲染从 `props.keys` 派生，`reload()` 后立即显示最新值。
 */
export function JevKeysPanel(props: {
  channelId?: string | null;
  baseUrl?: string;
  opened: boolean;
  onClose: () => void;
  keys: JevKeyDto[];
  loadError?: string | null;
  reload: () => Promise<void>;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // 不存快照：reload() 改变 updatedAt 后编辑弹窗立即显示新值；Key 被删除则自动关闭。
  const editingKey = props.keys.find((key) => key.id === editingKeyId) ?? null;

  function closeKeys() {
    setEditingKeyId(null);
    setPendingConfirm(null);
    setNotice(null);
    props.onClose();
  }

  function openEdit(id: string) {
    setNotice(null);
    setEditingKeyId(id);
  }

  function requestConfirm(kind: KeyConfirmKind, key: JevKeyDto) {
    setNotice(null);
    setPendingConfirm({ kind, key });
  }

  function requestPurgeDisabled(keys: JevKeyDto[]) {
    if (keys.length === 0) return;
    setNotice(null);
    setPendingConfirm({ kind: "purge-disabled", keys });
  }

  function finishEdit(message: string) {
    setNotice({ kind: "success", text: message });
  }

  function failEdit(message: string) {
    setNotice({ kind: "error", text: message });
  }

  // 破坏性操作共用：成功关确认弹窗并刷新；失败把错误写进弹窗内并保留确认弹窗以便重试。
  async function guard(action: () => Promise<string>): Promise<boolean> {
    setConfirmBusy(true);
    try {
      const message = await action();
      setNotice({ kind: "success", text: message });
      setPendingConfirm(null);
      await props.reload();
      return true;
    } catch (caught) {
      setNotice({ kind: "error", text: errorMessage(caught) });
      return false;
    } finally {
      setConfirmBusy(false);
    }
  }

  async function confirmPending() {
    const pending = pendingConfirm;
    if (!pending) return;

    const ok = await guard(async () => {
      switch (pending.kind) {
        case "clear":
          await apiSend(`/api/settings/jev/keys/${pending.key.id}`, "PATCH", {
            apiKey: { clear: true },
          });
          return `已清除「${pending.key.label}」的密钥并停用该 Key。`;
        case "disable":
          await apiSend(`/api/settings/jev/keys/${pending.key.id}`, "PATCH", {
            enabled: false,
          });
          return `已停用「${pending.key.label}」。`;
        case "delete":
          await apiSend(`/api/settings/jev/keys/${pending.key.id}`, "DELETE");
          return `已删除 Key「${pending.key.label}」。`;
        case "purge-disabled": {
          // 服务端在执行时重新判定禁用集合，提示必须用返回数量而不是打开弹窗时的快照。
          const result = await apiSend<BatchDeleteJevKeysResultDto>(
            "/api/settings/jev/keys/batch-delete",
            "POST",
            { scope: "disabled" },
          );
          const removed = result.removedIds.length;
          return removed === 0
            ? "没有可删除的禁用的 Key。"
            : `已删除 ${removed} 个禁用的 Key。`;
        }
      }
    });

    if (ok && pending.kind === "delete") setEditingKeyId(null);
  }

  return (
    <Modal.Stack>
      <Modal
        opened={props.opened}
        onClose={closeKeys}
        stackId="jev-keys"
        title="Jev API 密钥"
        size={1200}
        centered
      >
        <KeysModalBody
          channelId={props.channelId}
          baseUrl={props.baseUrl}
          keys={props.keys}
          notice={notice}
          loadError={props.loadError}
          onEdit={openEdit}
          onRequestPurge={requestPurgeDisabled}
          onDone={finishEdit}
          onError={failEdit}
          reload={props.reload}
        />
      </Modal>

      <Modal
        opened={editingKey !== null}
        onClose={() => setEditingKeyId(null)}
        stackId="jev-key-edit"
        title={editingKey ? `编辑密钥：${editingKey.label}` : "编辑密钥"}
        size="lg"
        centered
      >
        <div className="stack">
          <PanelNotice notice={notice} />
          {editingKey ? (
            <KeyEditForm
              key={`${editingKey.id}:${editingKey.updatedAt}`}
              item={editingKey}
              onDone={finishEdit}
              onError={failEdit}
              onRequestConfirm={requestConfirm}
              reload={props.reload}
            />
          ) : null}
        </div>
      </Modal>

      <Modal
        opened={pendingConfirm !== null}
        onClose={() => setPendingConfirm(null)}
        stackId="jev-confirm"
        title="确认操作"
        centered
      >
        <div className="stack">
          <PanelNotice notice={notice} />
          <p style={{ margin: 0 }}>{pendingConfirm ? confirmText(pendingConfirm) : ""}</p>
          {pendingConfirm?.kind === "purge-disabled" ? (
            <p className="muted small" style={{ margin: 0 }}>
              {purgeKeyNames(pendingConfirm.keys)}
            </p>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              variant="default"
              size="sm"
              disabled={confirmBusy}
              onClick={() => setPendingConfirm(null)}
            >
              取消
            </Button>
            <Button
              color="red"
              size="sm"
              loading={confirmBusy}
              onClick={() => void confirmPending()}
            >
              确认
            </Button>
          </div>
        </div>
      </Modal>
    </Modal.Stack>
  );
}
