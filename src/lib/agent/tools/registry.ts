import type Database from "better-sqlite3";
import {
  listRunnableStage2Tools,
  recordStage2ToolFailure,
  recordStage2ToolSuccess,
  resetStage2ToolCircuit,
  updateStage2Tool,
} from "@/lib/db/repos/stage2-tools";
import type {
  HttpApiToolConfig,
  McpToolConfig,
  Stage2ToolRecord,
} from "@/lib/domain/types";
import { readToolSecret } from "@/lib/service/stage2-tools";
import { createCalculatorTool } from "@/lib/agent/tools/builtin-calculator";
import { createLocalHistoryTool } from "@/lib/agent/tools/builtin-local-history";
import {
  createMcpRegisteredTools,
  discoverMcpTools,
} from "@/lib/agent/tools/mcp-adapter";
import {
  callHttpApiTool,
  createHttpApiRegisteredTool,
} from "@/lib/agent/tools/http-adapter";
import type { RegisteredTool } from "@/lib/agent/tools/types";

export interface BuildRunnableToolsOptions {
  currentBulletinId?: string;
  now?: Date;
  encryptionKey?: Buffer;
  fetchImpl?: typeof fetch;
}

function wrapWithCircuitBreaker(
  db: Database.Database,
  tool: RegisteredTool,
  now?: Date,
): RegisteredTool {
  return {
    ...tool,
    execute: async (args) => {
      const outcome = await tool.execute(args);
      if (outcome.ok) {
        recordStage2ToolSuccess(db, tool.pluginId, now ?? new Date());
      } else if (outcome.infrastructureFailure) {
        recordStage2ToolFailure(
          db,
          tool.pluginId,
          outcome.error ?? "基础设施故障",
          now ?? new Date(),
        );
      }
      return outcome;
    },
  };
}

/**
 * 从 `stage2_tools` 动态装配当前健康且已启用的工具插件，
 * 并自动包装跨请求熔断回调。
 */
export function buildRunnableTools(
  db: Database.Database,
  options: BuildRunnableToolsOptions = {},
): RegisteredTool[] {
  const plugins = listRunnableStage2Tools(db, options.now ?? new Date());
  const registered: RegisteredTool[] = [];

  for (const plugin of plugins) {
    if (plugin.kind === "builtin") {
      if (plugin.builtinKey === "calculator") {
        registered.push(
          wrapWithCircuitBreaker(db, createCalculatorTool(plugin), options.now),
        );
      } else if (plugin.builtinKey === "local_history") {
        registered.push(
          wrapWithCircuitBreaker(
            db,
            createLocalHistoryTool(
              db,
              plugin,
              options.currentBulletinId,
              options.now,
            ),
            options.now,
          ),
        );
      }
      continue;
    }

    const { token, unreadable } = readToolSecret(
      db,
      plugin,
      options.encryptionKey,
    );
    if (unreadable) {
      // 加密密钥不可读时跳过注入，避免使用坏凭据触发误操作
      continue;
    }

    if (plugin.kind === "mcp") {
      const tools = createMcpRegisteredTools(plugin, token, options.fetchImpl);
      for (const t of tools) {
        registered.push(wrapWithCircuitBreaker(db, t, options.now));
      }
    } else if (plugin.kind === "http_api") {
      registered.push(
        wrapWithCircuitBreaker(
          db,
          createHttpApiRegisteredTool(plugin, token, options.fetchImpl),
          options.now,
        ),
      );
    }
  }

  return registered;
}

export interface ProbeToolResult {
  ok: boolean;
  message: string;
  discoveredToolsCount?: number;
  discoveredTools?: string[];
  circuitReset: boolean;
}

/**
 * 探测单个工具插件连通性；MCP 会同步刷新 `cached_schema_json`。
 * 探测成功立即重置熔断器。
 */
export async function probeStage2Tool(
  db: Database.Database,
  plugin: Stage2ToolRecord,
  options: { encryptionKey?: Buffer; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ProbeToolResult> {
  const now = options.now ?? new Date();

  if (plugin.kind === "builtin") {
    if (plugin.builtinKey === "calculator") {
      const calc = createCalculatorTool(plugin);
      const res = await calc.execute({
        mode: "unit_price",
        totalPrice: 10,
        packCount: 2,
        sizePerPack: 500,
        unit: "g",
      });
      if (res.ok) {
        resetStage2ToolCircuit(db, plugin.id, now);
        return {
          ok: true,
          message: "内置计算器自检通过",
          circuitReset: true,
        };
      }
      return {
        ok: false,
        message: res.error ?? "内置计算器自检失败",
        circuitReset: false,
      };
    }

    const history = createLocalHistoryTool(db, plugin, undefined, now);
    const res = await history.execute({ keywords: ["测试"] });
    if (res.ok) {
      resetStage2ToolCircuit(db, plugin.id, now);
      return {
        ok: true,
        message: "本地历史线报库查询自检通过",
        circuitReset: true,
      };
    }
    return {
      ok: false,
      message: res.error ?? "本地历史库自检失败",
      circuitReset: false,
    };
  }

  const { token, unreadable } = readToolSecret(
    db,
    plugin,
    options.encryptionKey,
  );
  if (unreadable) {
    return {
      ok: false,
      message: "凭据密文无法使用当前 APP_ENCRYPTION_KEY 解密，请重新填写或清除凭据",
      circuitReset: false,
    };
  }

  if (plugin.kind === "mcp") {
    const config = plugin.config as unknown as McpToolConfig;
    const discovered = await discoverMcpTools(
      config,
      token,
      options.fetchImpl,
    );
    if (!discovered.ok) {
      return {
        ok: false,
        message: discovered.error,
        circuitReset: false,
      };
    }
    updateStage2Tool(
      db,
      plugin.id,
      { cachedSchema: discovered.tools },
      now,
    );
    resetStage2ToolCircuit(db, plugin.id, now);
    return {
      ok: true,
      message: `MCP 连通成功，已同步 ${discovered.tools.length} 个子工具 Schema`,
      discoveredToolsCount: discovered.tools.length,
      discoveredTools: discovered.tools.map((t) => t.name),
      circuitReset: true,
    };
  }

  const config = plugin.config as unknown as HttpApiToolConfig;
  const res = await callHttpApiTool(
    config,
    token,
    { query: "ping" },
    options.fetchImpl,
  );
  if (res.ok) {
    resetStage2ToolCircuit(db, plugin.id, now);
    return {
      ok: true,
      message: "HTTP 接口探测成功，已重置熔断状态",
      circuitReset: true,
    };
  }
  return {
    ok: false,
    message: res.error ?? "HTTP 接口探测失败",
    circuitReset: false,
  };
}
