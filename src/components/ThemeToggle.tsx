"use client";

import { useSyncExternalStore } from "react";
import {
  Button,
  Menu,
  useMantineColorScheme,
  type MantineColorScheme,
} from "@mantine/core";
import { MonitorIcon, MoonIcon, SunIcon } from "@/components/ui/Icons";

/** 三种外观状态的展示文案（中文，唯一来源）。 */
const COLOR_SCHEME_OPTIONS: { value: MantineColorScheme; label: string }[] = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const LABELS: Record<MantineColorScheme, string> = {
  auto: "跟随系统",
  light: "浅色",
  dark: "深色",
};

// 挂载门控：MantineProvider 的 colorScheme 在客户端首帧会读取 localStorage，
// 与服务端渲染的 defaultColorScheme("auto") 不一致，直接渲染会触发 hydration 警告。
// 用 useSyncExternalStore 拿到「是否已在客户端挂载」——禁止用 useEffect + setState
// （react-hooks/set-state-in-effect 会报错）。
const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function SchemeIcon(props: { scheme: MantineColorScheme; mounted: boolean }) {
  if (!props.mounted || props.scheme === "auto") return <MonitorIcon />;
  return props.scheme === "dark" ? <MoonIcon /> : <SunIcon />;
}

/**
 * 外观主题切换：
 * - 三态：跟随系统 / 浅色 / 深色；持久化由 Mantine 负责（localStorage）。
 * - 未挂载时渲染稳定占位，挂载后再显示当前值，避免 hydration 不匹配。
 */
export function ThemeToggle(props: { variant?: "sidebar" | "compact" } = {}) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const mounted = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
  const variant = props.variant ?? "compact";

  return (
    <Menu
      position={variant === "sidebar" ? "top-start" : "bottom-end"}
      withinPortal
    >
      <Menu.Target>
        {variant === "sidebar" ? (
          <button
            type="button"
            className="sidebar-action"
            aria-label="外观主题"
          >
            <span className="sidebar-action-left">
              <SchemeIcon scheme={colorScheme} mounted={mounted} />
              <span>外观</span>
            </span>
            <span className="sidebar-action-meta">
              {mounted ? LABELS[colorScheme] : "…"}
            </span>
          </button>
        ) : (
          <Button
            variant="default"
            size="compact-sm"
            aria-label="外观主题"
            leftSection={<SchemeIcon scheme={colorScheme} mounted={mounted} />}
          >
            {mounted ? LABELS[colorScheme] : "外观"}
          </Button>
        )}
      </Menu.Target>
      <Menu.Dropdown>
        {COLOR_SCHEME_OPTIONS.map((option) => (
          <Menu.Item
            key={option.value}
            leftSection={<SchemeIcon scheme={option.value} mounted={true} />}
            onClick={() => setColorScheme(option.value)}
            rightSection={mounted && colorScheme === option.value ? "✓" : null}
          >
            {option.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
