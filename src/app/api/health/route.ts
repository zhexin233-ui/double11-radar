import { NextResponse } from "next/server";

/**
 * 容器健康检查端点：无需登录，仅返回 `{ ok: true }`。
 */
export function GET() {
  return NextResponse.json({ ok: true });
}
