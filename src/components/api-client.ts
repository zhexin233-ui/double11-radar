"use client";

/**
 * 客户端 API 封装。
 *
 * 统一携带 `x-requested-with: fetch`（服务端同源写入校验要求），
 * 解析统一返回结构 `{ ok, data | error }`；401 时跳转登录页。
 */

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    method: rest.method ?? (json === undefined ? "GET" : "POST"),
    headers: {
      "x-requested-with": "fetch",
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers ?? {}),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
    credentials: "same-origin",
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const body = payload as
    | { ok: true; data: T }
    | { ok: false; error: ApiErrorBody }
    | null;

  if (!response.ok || !body || body.ok !== true) {
    const error = body && body.ok === false ? body.error : null;
    if (response.status === 401 && typeof window !== "undefined") {
      // 会话过期时回到登录页；用 replace 避免在历史记录里留下受保护页面。
      window.location.replace("/login");
    }
    throw new ApiClientError(
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return body.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiSend<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  json?: unknown,
): Promise<T> {
  return request<T>(path, { method, json });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
