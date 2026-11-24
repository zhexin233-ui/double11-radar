import type Database from "better-sqlite3";
import { clearSecret, getSecret } from "@/lib/db/repos/settings";
import {
  countStage2Tools,
  createStage2Tool,
  deleteStage2Tool,
  getStage2Tool,
  listStage2Tools,
  resetStage2ToolCircuit,
  updateStage2Tool,
} from "@/lib/db/repos/stage2-tools";
import type {
  HttpApiToolConfig,
  LocalHistoryToolConfig,
  McpToolConfig,
  Stage2ToolKind,
  Stage2ToolRecord,
} from "@/lib/domain/types";
import { HttpError } from "@/lib/http/json";
import {
  applySecretInput,
  readSecretStateMasked,
  type SecretInput,
  type SecretState,
} from "@/lib/service/config";
import { validateHttpUrlOrThrow } from "@/lib/service/stage2-config";

export const MAX_STAGE2_TOOLS = 50;

export interface Stage2ToolView extends Stage2ToolRecord {
  secretState: SecretState;
}

const UNCONFIGURED_SECRET: SecretState = {
  configured: false,
  masked: null,
  unreadable: false,
};

function attachSecretState(
  db: Database.Database,
  tool: Stage2ToolRecord,
  key?: Buffer,
): Stage2ToolView {
  return {
    ...tool,
    secretState: tool.secretNamespace
      ? readSecretStateMasked(db, tool.secretNamespace, key)
      : { ...UNCONFIGURED_SECRET },
  };
}

export function listStage2ToolsWithSecrets(
  db: Database.Database,
  key?: Buffer,
): Stage2ToolView[] {
  return listStage2Tools(db).map((tool) => attachSecretState(db, tool, key));
}

export function getStage2ToolWithSecret(
  db: Database.Database,
  id: string,
  key?: Buffer,
): Stage2ToolView | null {
  const tool = getStage2Tool(db, id);
  return tool ? attachSecretState(db, tool, key) : null;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeHeaderName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9-]+$/.test(trimmed)) {
    throw new HttpError("INVALID_HEADER", "鉴权请求头名称仅支持字母、数字和连字符", 400);
  }
  return trimmed;
}

function validateMcpConfig(raw: Record<string, unknown>): McpToolConfig {
  const endpointUrl = validateHttpUrlOrThrow(raw.endpointUrl, "MCP 服务地址");
  const authHeader = normalizeHeaderName(raw.authHeader, "Authorization");
  const authPrefix =
    typeof raw.authPrefix === "string" ? raw.authPrefix : "Bearer ";
  const timeoutMs = clampInt(raw.timeoutMs, 10_000, 1_000, 60_000);
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : undefined;

  return {
    endpointUrl,
    authHeader,
    authPrefix,
    timeoutMs,
    ...(allowedTools ? { allowedTools } : {}),
  };
}

function validateHttpApiConfig(raw: Record<string, unknown>): HttpApiToolConfig {
  const functionName =
    typeof raw.functionName === "string" ? raw.functionName.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(functionName)) {
    throw new HttpError(
      "INVALID_FUNCTION_NAME",
      "函数名仅支持 1-64 位字母、数字、下划线或连字符",
      400,
    );
  }
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) {
    throw new HttpError("INVALID_DESCRIPTION", "HTTP 工具用途说明不能为空", 400);
  }
  const endpointUrl = validateHttpUrlOrThrow(raw.endpointUrl, "HTTP 接口地址");
  const method = raw.method === "POST" ? "POST" : "GET";
  const queryParamName =
    typeof raw.queryParamName === "string" && raw.queryParamName.trim()
      ? raw.queryParamName.trim()
      : "q";
  const authHeader = normalizeHeaderName(raw.authHeader, "Authorization");
  const authPrefix =
    typeof raw.authPrefix === "string" ? raw.authPrefix : "Bearer ";
  const timeoutMs = clampInt(raw.timeoutMs, 10_000, 1_000, 60_000);
  const maxResponseBytes = clampInt(raw.maxResponseBytes, 12_288, 512, 65_536);

  return {
    functionName,
    description,
    endpointUrl,
    method,
    queryParamName,
    authHeader,
    authPrefix,
    timeoutMs,
    maxResponseBytes,
  };
}

function validateLocalHistoryConfig(
  raw: Record<string, unknown>,
): LocalHistoryToolConfig {
  return {
    historyDays: clampInt(raw.historyDays, 90, 1, 365),
    maxResults: clampInt(raw.maxResults, 20, 1, 50),
  };
}

export interface CreateExternalStage2ToolInput {
  name: string;
  kind: Exclude<Stage2ToolKind, "builtin">;
  enabled?: boolean;
  sortOrder?: number;
  config: Record<string, unknown>;
  failureThreshold?: number;
  cooldownMinutes?: number;
  secret?: SecretInput;
}

export function createExternalStage2Tool(
  db: Database.Database,
  input: CreateExternalStage2ToolInput,
  key?: Buffer,
): Stage2ToolView {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new HttpError("INVALID_NAME", "工具插件名称不能为空", 400);
  }
  if (input.kind !== "mcp" && input.kind !== "http_api") {
    throw new HttpError("INVALID_KIND", "仅支持新增 mcp 或 http_api 类型插件", 400);
  }

  const validatedConfig =
    input.kind === "mcp"
      ? validateMcpConfig(input.config ?? {})
      : validateHttpApiConfig(input.config ?? {});

  const tx = db.transaction(() => {
    if (countStage2Tools(db) >= MAX_STAGE2_TOOLS) {
      throw new HttpError(
        "TOO_MANY_TOOLS",
        `工具插件数量已达上限（${MAX_STAGE2_TOOLS} 个）`,
        400,
      );
    }

    const created = createStage2Tool(db, {
      name,
      kind: input.kind,
      enabled: input.enabled,
      sortOrder: clampInt(input.sortOrder, 100, 0, 9999),
      config: validatedConfig as unknown as Record<string, unknown>,
      failureThreshold: clampInt(input.failureThreshold, 3, 1, 20),
      cooldownMinutes: clampInt(input.cooldownMinutes, 15, 1, 1440),
    });

    if (created.secretNamespace && input.secret !== undefined) {
      applySecretInput(db, created.secretNamespace, input.secret, key);
    }

    return attachSecretState(db, created, key);
  });

  return tx.immediate();
}

export interface UpdateStage2ToolServiceInput {
  name?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
  failureThreshold?: number;
  cooldownMinutes?: number;
  secret?: SecretInput;
  resetCircuit?: boolean;
}

export function updateStage2ToolService(
  db: Database.Database,
  id: string,
  input: UpdateStage2ToolServiceInput,
  key?: Buffer,
): Stage2ToolView {
  const tx = db.transaction(() => {
    const existing = getStage2Tool(db, id);
    if (!existing) {
      throw new HttpError("TOOL_NOT_FOUND", "工具插件不存在", 404);
    }

    let nextConfig = existing.config;
    if (input.config !== undefined) {
      if (existing.kind === "mcp") {
        nextConfig = validateMcpConfig(input.config) as unknown as Record<
          string,
          unknown
        >;
      } else if (existing.kind === "http_api") {
        nextConfig = validateHttpApiConfig(input.config) as unknown as Record<
          string,
          unknown
        >;
      } else if (existing.builtinKey === "local_history") {
        nextConfig = validateLocalHistoryConfig(input.config) as unknown as Record<
          string,
          unknown
        >;
      }
    }

    const nextName =
      input.name !== undefined
        ? (() => {
            const trimmed = input.name.trim();
            if (!trimmed) {
              throw new HttpError("INVALID_NAME", "工具插件名称不能为空", 400);
            }
            return trimmed;
          })()
        : existing.name;

    updateStage2Tool(db, id, {
      name: nextName,
      enabled: input.enabled,
      sortOrder:
        input.sortOrder !== undefined
          ? clampInt(input.sortOrder, existing.sortOrder, 0, 9999)
          : undefined,
      config: nextConfig,
      failureThreshold:
        input.failureThreshold !== undefined
          ? clampInt(input.failureThreshold, existing.failureThreshold, 1, 20)
          : undefined,
      cooldownMinutes:
        input.cooldownMinutes !== undefined
          ? clampInt(input.cooldownMinutes, existing.cooldownMinutes, 1, 1440)
          : undefined,
    });

    if (existing.secretNamespace && input.secret !== undefined) {
      applySecretInput(db, existing.secretNamespace, input.secret, key);
    }

    if (input.resetCircuit) {
      resetStage2ToolCircuit(db, id);
    }

    return attachSecretState(db, getStage2Tool(db, id)!, key);
  });

  return tx.immediate();
}

export function deleteStage2ToolService(
  db: Database.Database,
  id: string,
): void {
  const tx = db.transaction(() => {
    const existing = getStage2Tool(db, id);
    if (!existing) {
      throw new HttpError("TOOL_NOT_FOUND", "工具插件不存在", 404);
    }
    if (existing.kind === "builtin") {
      throw new HttpError(
        "BUILTIN_TOOL_PROTECTED",
        "内置插件不可删除，可选择禁用",
        400,
      );
    }
    deleteStage2Tool(db, id);
    if (existing.secretNamespace) {
      clearSecret(db, existing.secretNamespace);
    }
  });

  tx.immediate();
}

export function readToolSecret(
  db: Database.Database,
  tool: Stage2ToolRecord,
  key?: Buffer,
): { token: string | null; unreadable: boolean } {
  if (!tool.secretNamespace) {
    return { token: null, unreadable: false };
  }
  try {
    return {
      token: getSecret(db, tool.secretNamespace, key),
      unreadable: false,
    };
  } catch {
    return { token: null, unreadable: true };
  }
}
