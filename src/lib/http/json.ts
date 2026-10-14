import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * API 统一返回与错误处理。
 *
 * 成功：`{ ok: true, data }`；失败：`{ ok: false, error: { code, message } }`，message 为中文。
 */

/** 可预期的 HTTP 错误，携带业务错误码与状态码。 */
export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(
  code: string,
  message: string,
  status = 400,
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/**
 * 写操作的同源与 CSRF 保护：
 * 1. 必须携带 `x-requested-with: fetch`（前端统一 fetch 封装添加）；
 * 2. 若存在 Origin 头，其 host 必须与 Host（或 x-forwarded-host）一致。
 */
export function requireSameOrigin(req: Request): void {
  const requestedWith = req.headers.get("x-requested-with");
  if (!requestedWith || requestedWith.toLowerCase() !== "fetch") {
    throw new HttpError(
      "CSRF_HEADER_MISSING",
      "缺少 x-requested-with: fetch 请求头",
      403,
    );
  }

  const origin = req.headers.get("origin");
  if (!origin) return;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError("CSRF_ORIGIN_INVALID", "Origin 请求头不合法", 403);
  }

  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host || originHost !== host) {
    throw new HttpError(
      "CSRF_ORIGIN_MISMATCH",
      "请求来源与目标站点不一致",
      403,
    );
  }
}

/**
 * 把 zod 校验失败转成统一的中文 400 错误。
 *
 * zod 的默认信息是英文（例如 `Invalid input: expected string, received undefined`），
 * 而本项目要求 API 错误信息一律中文。因此：自定义的中文信息原样透出；
 * 其余情况回退为按字段名生成的中文提示，绝不让英文默认信息泄露到客户端。
 */
export function invalidBodyError(error: z.ZodError): HttpError {
  const issue = error.issues[0];
  const message = issue?.message ?? "";
  if (/[\u4e00-\u9fff]/.test(message)) {
    return new HttpError("INVALID_BODY", message, 400);
  }
  const path = issue?.path.join(".");
  return new HttpError(
    "INVALID_BODY",
    path ? `字段 ${path} 不合法` : "请求参数不合法，请检查后重试",
    400,
  );
}

type RouteHandler<Ctx> = (
  req: Request,
  ctx: Ctx,
) => Promise<Response> | Response;

/**
 * 包装路由处理器：把 HttpError 转为标准失败响应，其余异常记录并返回 500。
 */
export function handleRoute<Ctx = unknown>(handler: RouteHandler<Ctx>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.code, error.message, error.status);
      }
      console.error("[api] 未处理异常:", error);
      return fail("INTERNAL_ERROR", "服务器内部错误", 500);
    }
  };
}
