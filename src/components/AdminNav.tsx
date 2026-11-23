"use client";

import { useEffect, useState, type ComponentType } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiSend } from "@/components/api-client";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  ActivityIcon,
  BellIcon,
  BrandMarkIcon,
  BulletinIcon,
  ChannelsIcon,
  CloseIcon,
  LogoutIcon,
  MenuIcon,
  NeedsIcon,
  SlidersIcon,
  StorageIcon,
} from "@/components/ui/Icons";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "监测与记录",
    items: [
      { href: "/status", label: "运行状态", icon: ActivityIcon },
      { href: "/bulletins", label: "线报记录", icon: BulletinIcon },
      { href: "/needs", label: "需求清单", icon: NeedsIcon },
    ],
  },
  {
    label: "采集与配置",
    items: [
      { href: "/channels", label: "采集频道", icon: ChannelsIcon },
      { href: "/jev", label: "模型配置", icon: SlidersIcon },
      { href: "/push", label: "推送渠道", icon: BellIcon },
      { href: "/storage", label: "存储设置", icon: StorageIcon },
    ],
  },
];

/**
 * 精确路径或路径段前缀匹配。
 * 使用 `${href}/` 前缀而不是裸字符串前缀，避免 `/needs` 误匹配 `/needs-archive`。
 */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function BrandHeader(props: { onNavigate?: () => void }) {
  return (
    <Link className="brand-link" href="/status" onClick={props.onNavigate}>
      <span className="brand-mark" aria-hidden="true">
        <BrandMarkIcon />
      </span>
      <span className="brand-text">
        <span className="brand-title">线报需求匹配</span>
        <span className="brand-sub">LOCAL MONITOR</span>
      </span>
    </Link>
  );
}

function NavGroupsList(props: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="sidebar-nav" aria-label="管理入口">
      {NAV_GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          {group.items.map((item) => {
            const active = isActive(props.pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="nav-link"
                aria-current={active ? "page" : undefined}
                onClick={props.onNavigate}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Esc 关闭移动端抽屉，不触碰文档顺序焦点起点
  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  async function logout() {
    setDrawerOpen(false);
    try {
      await apiSend("/api/auth/logout", "POST", {});
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <>
      {/* 桌面端：左侧固定精简侧边栏 */}
      <aside className="sidebar" aria-label="侧边导航">
        <BrandHeader />
        <NavGroupsList pathname={pathname} />
        <div className="sidebar-footer">
          <ThemeToggle variant="sidebar" />
          <button
            type="button"
            className="sidebar-action"
            onClick={() => void logout()}
          >
            <span className="sidebar-action-left">
              <LogoutIcon size={15} />
              <span>退出登录</span>
            </span>
          </button>
        </div>
      </aside>

      {/* 移动端 / 窄屏：紧凑顶栏 + 无障碍抽屉 */}
      <header className="mobile-bar">
        <div className="mobile-bar-left">
          <button
            type="button"
            className="icon-btn"
            aria-label="打开导航菜单"
            aria-expanded={drawerOpen}
            aria-controls="mobile-nav-drawer"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </button>
          <Link className="mobile-brand" href="/status">
            <span className="brand-mark" aria-hidden="true">
              <BrandMarkIcon />
            </span>
            <span>线报需求匹配</span>
          </Link>
        </div>
        <ThemeToggle variant="compact" />
      </header>

      {drawerOpen ? (
        <>
          <div
            className="mobile-backdrop"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            id="mobile-nav-drawer"
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="移动导航菜单"
          >
            <div className="mobile-drawer-head">
              <Link
                className="mobile-brand"
                href="/status"
                onClick={() => setDrawerOpen(false)}
              >
                <span className="brand-mark" aria-hidden="true">
                  <BrandMarkIcon />
                </span>
                <span>线报需求匹配</span>
              </Link>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭导航菜单"
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <NavGroupsList
              pathname={pathname}
              onNavigate={() => setDrawerOpen(false)}
            />
            <div className="sidebar-footer">
              <ThemeToggle variant="sidebar" />
              <button
                type="button"
                className="sidebar-action"
                onClick={() => void logout()}
              >
                <span className="sidebar-action-left">
                  <LogoutIcon size={15} />
                  <span>退出登录</span>
                </span>
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}
