"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiSend } from "@/components/api-client";

const LINKS = [
  { href: "/status", label: "运行状态" },
  { href: "/bulletins", label: "线报记录" },
  { href: "/needs", label: "需求清单" },
  { href: "/channels", label: "采集频道" },
  { href: "/jev", label: "Jev 配置" },
  { href: "/push", label: "推送渠道" },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    try {
      await apiSend("/api/auth/logout", "POST", {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <strong>线报需求匹配</strong>
        <nav>
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={
                pathname === link.href
                  ? { background: "var(--bg)", fontWeight: 600 }
                  : undefined
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={logout}>
          退出登录
        </button>
      </div>
    </header>
  );
}
