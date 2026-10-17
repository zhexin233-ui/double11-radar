"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@mantine/core";
import { apiSend } from "@/components/api-client";
import { ThemeToggle } from "@/components/ThemeToggle";

const LINKS = [
  { href: "/status", label: "运行状态" },
  { href: "/bulletins", label: "线报记录" },
  { href: "/needs", label: "需求清单" },
  { href: "/channels", label: "采集频道" },
  { href: "/jev", label: "Jev 配置" },
  { href: "/push", label: "推送渠道" },
];

/**
 * 精确路径或路径段前缀匹配。
 * 使用 `${href}/` 前缀而不是裸字符串前缀，避免 `/needs` 误匹配 `/needs-archive`。
 */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const navRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // 窄屏入口横向滚动时，保证当前入口可见。
  // 这里只滚动 nav 容器本身（不用 scrollIntoView），否则会把文档的顺序焦点起点
  // 移到活动项，导致首次 Tab 跳过「跳至正文」和前面的入口。
  useEffect(() => {
    const nav = navRef.current;
    const active = activeRef.current;
    if (!nav || !active) return;
    if (nav.scrollWidth <= nav.clientWidth) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const delta =
      activeRect.left - navRect.left - (navRect.width - activeRect.width) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    nav.scrollTo({ left: nav.scrollLeft + delta, behavior: reduce ? "auto" : "smooth" });
  }, [pathname]);

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
        <Link className="brand" href="/status">
          线报需求匹配
        </Link>
        <nav aria-label="管理入口" ref={navRef}>
          {LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                ref={active ? activeRef : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
        <Button variant="default" size="compact-md" onClick={logout}>
          退出登录
        </Button>
      </div>
    </header>
  );
}
