"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Radio,
  Select,
  Switch,
  Textarea,
  TextInput,
} from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { useApiResource } from "@/components/use-api";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";
import { formatTime } from "@/components/format";
import {
  STAGE2_TOOL_KIND_LABELS,
  type Stage2SettingsDto,
  type Stage2ToolViewDto,
} from "@/components/api-types";

type SecretInputDto = string | { clear: true } | null | undefined;

type SecretMode = "keep" | "replace" | "clear";

function toNumber(val: number | string, fallback: number): number {
  if (val === "" || val === null || val === undefined) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function formatCooldownRemaining(cooldownUntil: string | null): string {
  if (!cooldownUntil) return "—";
  const ms = new Date(cooldownUntil).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "即将半开试探";
  const mins = Math.ceil(ms / 60_000);
  return `剩余约 ${mins} 分钟`;
}

export function Stage2SettingsPanel() {
  const {
    data,
    error,
    reload,
  } = useApiResource<Stage2SettingsDto>("/api/settings/stage2");

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);

  // 引擎表单状态（首次加载或重置后同步）
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [includeUncertain, setIncludeUncertain] = useState(false);
  const [notifyOnInsufficientInfo, setNotifyOnInsufficientInfo] =
    useState(false);
  const [fallbackToStage1Notify, setFallbackToStage1Notify] = useState(true);
  const [concurrency, setConcurrency] = useState(1);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [timeoutMs, setTimeoutMs] = useState(25000);
  const [maxSteps, setMaxSteps] = useState(5);
  const [temperature, setTemperature] = useState(0.1);
  const [apiKeyMode, setApiKeyMode] = useState<SecretMode>("keep");
  const [apiKeyInput, setApiKeyInput] = useState("");

  if (data && draftVersion !== data.version) {
    setDraftVersion(data.version);
    setEnabled(data.config.enabled);
    setIncludeUncertain(data.config.includeUncertain);
    setNotifyOnInsufficientInfo(data.config.notifyOnInsufficientInfo);
    setFallbackToStage1Notify(data.config.fallbackToStage1Notify);
    setConcurrency(data.config.concurrency);
    setBaseUrl(data.config.llm.baseUrl);
    setModel(data.config.llm.model);
    setTimeoutMs(data.config.llm.timeoutMs);
    setMaxSteps(data.config.llm.maxSteps);
    setTemperature(data.config.llm.temperature);
    setApiKeyMode("keep");
    setApiKeyInput("");
  }

  // 插件弹窗状态
  const [toolModalOpen, setToolModalOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<Stage2ToolViewDto | null>(null);
  const [toolKind, setToolKind] = useState<"mcp" | "http_api">("mcp");
  const [toolName, setToolName] = useState("");
  const [toolSortOrder, setToolSortOrder] = useState(100);
  const [toolFailureThreshold, setToolFailureThreshold] = useState(3);
  const [toolCooldownMinutes, setToolCooldownMinutes] = useState(15);
  const [toolSecretMode, setToolSecretMode] = useState<SecretMode>("keep");
  const [toolSecretInput, setToolSecretInput] = useState("");
  // MCP 字段
  const [mcpEndpointUrl, setMcpEndpointUrl] = useState("");
  const [mcpAuthHeader, setMcpAuthHeader] = useState("Authorization");
  const [mcpAuthPrefix, setMcpAuthPrefix] = useState("Bearer ");
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState(10000);
  const [mcpAllowedToolsText, setMcpAllowedToolsText] = useState("");
  // HTTP API 字段
  const [httpFunctionName, setHttpFunctionName] = useState("query_price_api");
  const [httpDescription, setHttpDescription] = useState("");
  const [httpEndpointUrl, setHttpEndpointUrl] = useState("");
  const [httpMethod, setHttpMethod] = useState<"GET" | "POST">("GET");
  const [httpQueryParam, setHttpQueryParam] = useState("q");
  const [httpAuthHeader, setHttpAuthHeader] = useState("Authorization");
  const [httpAuthPrefix, setHttpAuthPrefix] = useState("Bearer ");
  const [httpTimeoutMs, setHttpTimeoutMs] = useState(10000);
  const [httpMaxBytes, setHttpMaxBytes] = useState(12288);
  // 内置 local_history 字段
  const [localHistoryDays, setLocalHistoryDays] = useState(90);
  const [localHistoryMaxResults, setLocalHistoryMaxResults] = useState(20);

  const [busyToolId, setBusyToolId] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState(false);

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSavingConfig(true);
    setNotice(null);
    setActionError(null);
    try {
      const apiKey: SecretInputDto =
        apiKeyMode === "clear"
          ? { clear: true }
          : apiKeyMode === "replace"
            ? apiKeyInput
            : undefined;

      await apiSend("/api/settings/stage2", "PUT", {
        enabled,
        includeUncertain,
        notifyOnInsufficientInfo,
        fallbackToStage1Notify,
        concurrency,
        llm: {
          baseUrl,
          model,
          timeoutMs,
          maxSteps,
          temperature,
        },
        apiKey,
        expectedVersion: data?.version,
      });
      setNotice("二级核验引擎配置已保存。");
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleTestLlm() {
    setTestingLlm(true);
    setNotice(null);
    setActionError(null);
    try {
      const res = await apiSend<{
        ok: boolean;
        latencyMs: number;
        replyPreview: string;
      }>("/api/settings/stage2/test-llm", "POST", {
        baseUrl,
        model,
        timeoutMs,
        ...(apiKeyMode === "replace" && apiKeyInput.trim()
          ? { apiKey: apiKeyInput.trim() }
          : {}),
      });
      setNotice(
        `二级 LLM 连通成功（${res.latencyMs}ms），返回：${res.replyPreview || "OK"}`,
      );
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setTestingLlm(false);
    }
  }

  function openCreateTool() {
    setEditingTool(null);
    setToolKind("mcp");
    setToolName("");
    setToolSortOrder(100);
    setToolFailureThreshold(3);
    setToolCooldownMinutes(15);
    setToolSecretMode("replace");
    setToolSecretInput("");
    setMcpEndpointUrl("");
    setMcpAuthHeader("Authorization");
    setMcpAuthPrefix("Bearer ");
    setMcpTimeoutMs(10000);
    setMcpAllowedToolsText("");
    setHttpFunctionName("query_price_api");
    setHttpDescription("");
    setHttpEndpointUrl("");
    setHttpMethod("GET");
    setHttpQueryParam("q");
    setHttpAuthHeader("Authorization");
    setHttpAuthPrefix("Bearer ");
    setHttpTimeoutMs(10000);
    setHttpMaxBytes(12288);
    setToolModalOpen(true);
  }

  function openEditTool(tool: Stage2ToolViewDto) {
    setEditingTool(tool);
    setToolKind(tool.kind === "http_api" ? "http_api" : "mcp");
    setToolName(tool.name);
    setToolSortOrder(tool.sortOrder);
    setToolFailureThreshold(tool.failureThreshold);
    setToolCooldownMinutes(tool.cooldownMinutes);
    setToolSecretMode("keep");
    setToolSecretInput("");

    const cfg = tool.config ?? {};
    if (tool.kind === "mcp") {
      setMcpEndpointUrl(String(cfg.endpointUrl ?? ""));
      setMcpAuthHeader(String(cfg.authHeader ?? "Authorization"));
      setMcpAuthPrefix(String(cfg.authPrefix ?? "Bearer "));
      setMcpTimeoutMs(Number(cfg.timeoutMs ?? 10000));
      setMcpAllowedToolsText(
        Array.isArray(cfg.allowedTools) ? cfg.allowedTools.join(", ") : "",
      );
    } else if (tool.kind === "http_api") {
      setHttpFunctionName(String(cfg.functionName ?? "query_price_api"));
      setHttpDescription(String(cfg.description ?? ""));
      setHttpEndpointUrl(String(cfg.endpointUrl ?? ""));
      setHttpMethod(cfg.method === "POST" ? "POST" : "GET");
      setHttpQueryParam(String(cfg.queryParamName ?? "q"));
      setHttpAuthHeader(String(cfg.authHeader ?? "Authorization"));
      setHttpAuthPrefix(String(cfg.authPrefix ?? "Bearer "));
      setHttpTimeoutMs(Number(cfg.timeoutMs ?? 10000));
      setHttpMaxBytes(Number(cfg.maxResponseBytes ?? 12288));
    } else if (tool.builtinKey === "local_history") {
      setLocalHistoryDays(Number(cfg.historyDays ?? 90));
      setLocalHistoryMaxResults(Number(cfg.maxResults ?? 20));
    }

    setToolModalOpen(true);
  }

  async function handleSaveTool(e: React.FormEvent) {
    e.preventDefault();
    setSavingTool(true);
    setNotice(null);
    setActionError(null);
    try {
      const secret: SecretInputDto =
        toolSecretMode === "clear"
          ? { clear: true }
          : toolSecretMode === "replace"
            ? toolSecretInput
            : undefined;

      const buildConfig = () => {
        if (editingTool?.kind === "builtin") {
          return editingTool.builtinKey === "local_history"
            ? {
                historyDays: localHistoryDays,
                maxResults: localHistoryMaxResults,
              }
            : {};
        }
        const kind = editingTool ? editingTool.kind : toolKind;
        if (kind === "mcp") {
          const allowedTools = mcpAllowedToolsText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          return {
            endpointUrl: mcpEndpointUrl,
            authHeader: mcpAuthHeader,
            authPrefix: mcpAuthPrefix,
            timeoutMs: mcpTimeoutMs,
            ...(allowedTools.length > 0 ? { allowedTools } : {}),
          };
        }
        return {
          functionName: httpFunctionName,
          description: httpDescription,
          endpointUrl: httpEndpointUrl,
          method: httpMethod,
          queryParamName: httpQueryParam,
          authHeader: httpAuthHeader,
          authPrefix: httpAuthPrefix,
          timeoutMs: httpTimeoutMs,
          maxResponseBytes: httpMaxBytes,
        };
      };

      if (editingTool) {
        await apiSend(`/api/settings/stage2/tools/${editingTool.id}`, "PUT", {
          name: toolName,
          sortOrder: toolSortOrder,
          failureThreshold: toolFailureThreshold,
          cooldownMinutes: toolCooldownMinutes,
          config: buildConfig(),
          ...(editingTool.kind !== "builtin" ? { secret } : {}),
        });
        setNotice(`已更新工具插件「${toolName}」。`);
      } else {
        await apiSend("/api/settings/stage2/tools", "POST", {
          name: toolName,
          kind: toolKind,
          sortOrder: toolSortOrder,
          failureThreshold: toolFailureThreshold,
          cooldownMinutes: toolCooldownMinutes,
          config: buildConfig(),
          secret,
        });
        setNotice(`已新增外部工具插件「${toolName}」。`);
      }
      setToolModalOpen(false);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSavingTool(false);
    }
  }

  async function toggleToolEnabled(tool: Stage2ToolViewDto) {
    setBusyToolId(tool.id);
    setActionError(null);
    try {
      await apiSend(`/api/settings/stage2/tools/${tool.id}`, "PUT", {
        enabled: !tool.enabled,
      });
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyToolId(null);
    }
  }

  async function probeTool(tool: Stage2ToolViewDto) {
    setBusyToolId(tool.id);
    setNotice(null);
    setActionError(null);
    try {
      const res = await apiSend<{
        ok: boolean;
        message: string;
        circuitReset: boolean;
      }>(`/api/settings/stage2/tools/${tool.id}/test`, "POST", {});
      if (res.ok) {
        setNotice(`[${tool.name}] ${res.message}`);
      } else {
        setActionError(`[${tool.name}] ${res.message}`);
      }
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyToolId(null);
    }
  }

  async function removeTool(tool: Stage2ToolViewDto) {
    setBusyToolId(tool.id);
    setNotice(null);
    setActionError(null);
    try {
      await apiSend(`/api/settings/stage2/tools/${tool.id}`, "DELETE");
      setNotice(`已删除工具插件「${tool.name}」。`);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyToolId(null);
    }
  }

  if (error && !data) {
    return <Feedback kind="error">加载二级核验配置失败：{error}</Feedback>;
  }

  if (!data) {
    return <Feedback kind="loading">正在加载二级核验配置…</Feedback>;
  }

  return (
    <div style={{ display: "grid", gap: "var(--sp-5)" }}>
      {actionError ? <Feedback kind="error">{actionError}</Feedback> : null}
      {notice ? <Feedback kind="success">{notice}</Feedback> : null}

      <Section title="第二级深度核验引擎（OpenAI-Compatible）" alt>
        <p className="muted small" style={{ marginBottom: "var(--sp-3)" }}>
          第一级（Jev/Laya）继续作为低成本高速漏斗；开启第二级后，命中候选线报将进入受控工具调用循环，核算折算单价并对照历史/外部比价，输出标准化购买简报。
        </p>

        <form onSubmit={(e) => void handleSaveConfig(e)} className="form-grid">
          <Group gap="xl" wrap="wrap">
            <Switch
              label="启用第二级深度核验"
              checked={enabled}
              onChange={(e) => setEnabled(e.currentTarget.checked)}
            />
            <Switch
              label="将一级待确认（uncertain）一并送入二级补查"
              checked={includeUncertain}
              onChange={(e) => setIncludeUncertain(e.currentTarget.checked)}
            />
            <Switch
              label="二级判定为「信息不足」时仍发送风险提示通知"
              checked={notifyOnInsufficientInfo}
              onChange={(e) =>
                setNotifyOnInsufficientInfo(e.currentTarget.checked)
              }
            />
            <Switch
              label="二级失败重试耗尽后降级按一级模板推送（防漏推）"
              checked={fallbackToStage1Notify}
              onChange={(e) =>
                setFallbackToStage1Notify(e.currentTarget.checked)
              }
            />
          </Group>

          <TextInput
            label="二级 LLM 服务地址（Base URL）"
            description="支持 OpenAI-Compatible 接口，例如 https://api.openai.com/v1 或兼容网关"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            required
          />

          <TextInput
            label="二级模型名称"
            description="需支持 Function Calling / Tool Calling"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
            required
          />

          <Group grow align="flex-start">
            <NumberInput
              label="单轮请求超时（毫秒）"
              min={3000}
              max={120000}
              step={1000}
              value={timeoutMs}
              onChange={(v) => setTimeoutMs(toNumber(v, 25000))}
            />
            <NumberInput
              label="最大工具调用步数（1-8）"
              min={1}
              max={8}
              value={maxSteps}
              onChange={(v) => setMaxSteps(toNumber(v, 5))}
            />
            <NumberInput
              label="Worker 并发数（1-4）"
              min={1}
              max={4}
              value={concurrency}
              onChange={(v) => setConcurrency(toNumber(v, 1))}
            />
            <NumberInput
              label="采样温度（0-2）"
              min={0}
              max={2}
              step={0.1}
              decimalScale={2}
              value={temperature}
              onChange={(v) => setTemperature(toNumber(v, 0.1))}
            />
          </Group>

          <div>
            <Radio.Group
              label={`二级 LLM API 密钥（当前：${
                data.apiKeyState.unreadable
                  ? "密文不可解密，请重设"
                  : data.apiKeyState.configured
                    ? `已配置 ${data.apiKeyState.masked ?? ""}`
                    : "未配置"
              }）`}
              value={apiKeyMode}
              onChange={(v) => setApiKeyMode(v as SecretMode)}
            >
              <Group mt="xs">
                <Radio value="keep" label="保留原值" />
                <Radio value="replace" label="替换为新密钥" />
                <Radio value="clear" label="清除密钥" />
              </Group>
            </Radio.Group>
            {apiKeyMode === "replace" ? (
              <TextInput
                mt="xs"
                type="password"
                placeholder="输入新的 OpenAI-Compatible API Key"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.currentTarget.value)}
              />
            ) : null}
          </div>

          <Group>
            <Button type="submit" loading={savingConfig}>
              保存二级引擎配置
            </Button>
            <Button
              variant="default"
              loading={testingLlm}
              onClick={() => void handleTestLlm()}
            >
              测试二级 LLM 连接
            </Button>
          </Group>
        </form>
      </Section>

      <Section
        title="可插拔工具箱与熔断状态"
        actions={
          <Button size="compact-sm" onClick={openCreateTool}>
            新增外部工具（MCP / HTTP）
          </Button>
        }
      >
        <p className="muted small" style={{ marginBottom: "var(--sp-3)" }}>
          所有工具统一受熔断器保护：连续基础设施失败（超时/断连/401/403/429/5xx）达阈值后自动进入冷却期并从 LLM 工具列表中摘除，防止无效等待。业务无结果不触发熔断。
        </p>

        <TableScroll label="第二级可插拔工具列表">
          <table>
            <thead>
              <tr>
                <th>排序</th>
                <th>插件名称</th>
                <th>类型</th>
                <th>启用</th>
                <th>健康 / 熔断</th>
                <th>阈值 / 冷却</th>
                <th>最近错误</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.tools.map((tool) => (
                <tr key={tool.id}>
                  <td className="mono small">{tool.sortOrder}</td>
                  <td>
                    <div>{tool.name}</div>
                    {tool.kind === "mcp" && tool.cachedSchema ? (
                      <div className="muted small">
                        已缓存 {tool.cachedSchema.length} 个子工具
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <Badge variant="light" color="gray">
                      {STAGE2_TOOL_KIND_LABELS[tool.kind]}
                    </Badge>
                  </td>
                  <td>
                    <Switch
                      aria-label={`启用 ${tool.name}`}
                      checked={tool.enabled}
                      disabled={busyToolId === tool.id}
                      onChange={() => void toggleToolEnabled(tool)}
                    />
                  </td>
                  <td>
                    {tool.healthStatus === "healthy" ? (
                      <Badge variant="light" color="teal">
                        健康（连续失败 {tool.consecutiveFailures}）
                      </Badge>
                    ) : (
                      <div>
                        <Badge variant="light" color="red">
                          已熔断（{formatCooldownRemaining(tool.cooldownUntil)}）
                        </Badge>
                        {tool.lastFailureAt ? (
                          <div className="muted small">
                            {formatTime(tool.lastFailureAt)}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td className="mono small">
                    {tool.failureThreshold} 次 / {tool.cooldownMinutes} 分钟
                  </td>
                  <td className="small error" style={{ maxWidth: 220 }}>
                    {tool.lastError ?? "—"}
                  </td>
                  <td>
                    <Group gap="xs" wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="default"
                        loading={busyToolId === tool.id}
                        onClick={() => void probeTool(tool)}
                      >
                        {tool.kind === "mcp" ? "探测并同步" : "测试恢复"}
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={() => openEditTool(tool)}
                      >
                        编辑
                      </Button>
                      {tool.kind !== "builtin" ? (
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="red"
                          loading={busyToolId === tool.id}
                          onClick={() => void removeTool(tool)}
                        >
                          删除
                        </Button>
                      ) : null}
                    </Group>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Section>

      <Modal
        opened={toolModalOpen}
        onClose={() => setToolModalOpen(false)}
        title={
          editingTool ? `编辑工具插件：${editingTool.name}` : "新增外部工具插件"
        }
        size="lg"
      >
        <form onSubmit={(e) => void handleSaveTool(e)} className="form-grid">
          {!editingTool ? (
            <Select
              label="插件类型"
              data={[
                { value: "mcp", label: "通用 MCP Server (Streamable HTTP / SSE)" },
                { value: "http_api", label: "通用 REST HTTP API (GET / POST)" },
              ]}
              value={toolKind}
              onChange={(v) => setToolKind((v as "mcp" | "http_api") ?? "mcp")}
            />
          ) : null}

          <TextInput
            label="插件名称"
            value={toolName}
            onChange={(e) => setToolName(e.currentTarget.value)}
            required
          />

          <Group grow>
            <NumberInput
              label="排序权重（越小越靠前）"
              min={0}
              max={9999}
              value={toolSortOrder}
              onChange={(v) => setToolSortOrder(toNumber(v, 100))}
            />
            <NumberInput
              label="连续失败熔断阈值"
              min={1}
              max={20}
              value={toolFailureThreshold}
              onChange={(v) => setToolFailureThreshold(toNumber(v, 3))}
            />
            <NumberInput
              label="熔断冷却时间（分钟）"
              min={1}
              max={1440}
              value={toolCooldownMinutes}
              onChange={(v) => setToolCooldownMinutes(toNumber(v, 15))}
            />
          </Group>

          {editingTool?.kind === "builtin" ? (
            editingTool.builtinKey === "local_history" ? (
              <Group grow>
                <NumberInput
                  label="回溯历史天数"
                  min={1}
                  max={365}
                  value={localHistoryDays}
                  onChange={(v) => setLocalHistoryDays(toNumber(v, 90))}
                />
                <NumberInput
                  label="单次最多返回样本数"
                  min={1}
                  max={50}
                  value={localHistoryMaxResults}
                  onChange={(v) => setLocalHistoryMaxResults(toNumber(v, 20))}
                />
              </Group>
            ) : (
              <p className="muted small">内置价格计算器无需额外参数配置。</p>
            )
          ) : (editingTool ? editingTool.kind : toolKind) === "mcp" ? (
            <>
              <TextInput
                label="MCP Endpoint URL"
                placeholder="https://your-mcp.example.com/mcp"
                value={mcpEndpointUrl}
                onChange={(e) => setMcpEndpointUrl(e.currentTarget.value)}
                required
              />
              <Group grow>
                <TextInput
                  label="鉴权 Header"
                  value={mcpAuthHeader}
                  onChange={(e) => setMcpAuthHeader(e.currentTarget.value)}
                />
                <TextInput
                  label="鉴权前缀"
                  value={mcpAuthPrefix}
                  onChange={(e) => setMcpAuthPrefix(e.currentTarget.value)}
                />
                <NumberInput
                  label="超时（毫秒）"
                  min={1000}
                  max={60000}
                  value={mcpTimeoutMs}
                  onChange={(v) => setMcpTimeoutMs(toNumber(v, 10000))}
                />
              </Group>
              <TextInput
                label="允许暴露的子工具白名单（逗号分隔，留空表示全部）"
                placeholder="例如：search_history, check_coupon"
                value={mcpAllowedToolsText}
                onChange={(e) => setMcpAllowedToolsText(e.currentTarget.value)}
              />
            </>
          ) : (
            <>
              <Group grow>
                <TextInput
                  label="给模型调用的函数名（英文字母/数字/下划线）"
                  value={httpFunctionName}
                  onChange={(e) => setHttpFunctionName(e.currentTarget.value)}
                  required
                />
                <Select
                  label="HTTP 方法"
                  data={["GET", "POST"]}
                  value={httpMethod}
                  onChange={(v) => setHttpMethod(v === "POST" ? "POST" : "GET")}
                />
              </Group>
              <Textarea
                label="工具用途说明（展示给 LLM 决定何时调用）"
                value={httpDescription}
                onChange={(e) => setHttpDescription(e.currentTarget.value)}
                required
              />
              <TextInput
                label="接口 URL"
                placeholder="https://api.example.com/price-check"
                value={httpEndpointUrl}
                onChange={(e) => setHttpEndpointUrl(e.currentTarget.value)}
                required
              />
              <Group grow>
                <TextInput
                  label="GET 查询参数名"
                  value={httpQueryParam}
                  onChange={(e) => setHttpQueryParam(e.currentTarget.value)}
                />
                <TextInput
                  label="鉴权 Header"
                  value={httpAuthHeader}
                  onChange={(e) => setHttpAuthHeader(e.currentTarget.value)}
                />
                <TextInput
                  label="鉴权前缀"
                  value={httpAuthPrefix}
                  onChange={(e) => setHttpAuthPrefix(e.currentTarget.value)}
                />
              </Group>
              <Group grow>
                <NumberInput
                  label="超时（毫秒）"
                  min={1000}
                  max={60000}
                  value={httpTimeoutMs}
                  onChange={(v) => setHttpTimeoutMs(toNumber(v, 10000))}
                />
                <NumberInput
                  label="响应截断上限（字节）"
                  min={512}
                  max={65536}
                  value={httpMaxBytes}
                  onChange={(v) => setHttpMaxBytes(toNumber(v, 12288))}
                />
              </Group>
            </>
          )}

          {editingTool?.kind !== "builtin" ? (
            <div>
              <Radio.Group
                label={
                  editingTool
                    ? `鉴权凭据（当前：${
                        editingTool.secretState.configured
                          ? `已配置 ${editingTool.secretState.masked ?? ""}`
                          : "未配置"
                      }）`
                    : "鉴权凭据（可选，服务端加密保存）"
                }
                value={toolSecretMode}
                onChange={(v) => setToolSecretMode(v as SecretMode)}
              >
                <Group mt="xs">
                  {editingTool ? (
                    <Radio value="keep" label="保留原值" />
                  ) : null}
                  <Radio value="replace" label="设置/替换凭据" />
                  {editingTool ? (
                    <Radio value="clear" label="清除凭据" />
                  ) : null}
                </Group>
              </Radio.Group>
              {toolSecretMode === "replace" ? (
                <TextInput
                  mt="xs"
                  type="password"
                  placeholder="输入 Bearer Token 或 API Key（可留空表示无需鉴权）"
                  value={toolSecretInput}
                  onChange={(e) => setToolSecretInput(e.currentTarget.value)}
                />
              ) : null}
            </div>
          ) : null}

          <Group justify="flex-end" mt="md">
            <Button
              variant="default"
              onClick={() => setToolModalOpen(false)}
              disabled={savingTool}
            >
              取消
            </Button>
            <Button type="submit" loading={savingTool}>
              保存插件
            </Button>
          </Group>
        </form>
      </Modal>
    </div>
  );
}
