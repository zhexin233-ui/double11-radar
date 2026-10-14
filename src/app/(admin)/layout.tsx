import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/domain/constants";
import { AdminNav } from "@/components/AdminNav";

/**
 * 管理区服务端布局：未登录直接重定向到登录页。
 * 各 API 路由仍会在服务端独立校验会话，不依赖本布局。
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const db = getDb();
  const session = token ? getSession(db, token) : null;
  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <AdminNav />
      <main>{children}</main>
    </div>
  );
}
