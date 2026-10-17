"use client";

import { useSyncExternalStore } from "react";
import {
  Button,
  Menu,
  useMantineColorScheme,
  type MantineColorScheme,
} from "@mantine/core";

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

/**
 * 顶部导航的外观切换：
 * - 三态：跟随系统 / 浅色 / 深色；持久化由 Mantine 负责（localStorage）。
 * - 未挂载时只渲染稳定文本「外观」，挂载后再显示当前值，避免 hydration 不匹配。
 */
export function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const mounted = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button variant="default" size="compact-md" aria-label="外观主题">
          {mounted ? `外观：${LABELS[colorScheme]}` : "外观"}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {COLOR_SCHEME_OPTIONS.map((option) => (
          <Menu.Item
            key={option.value}
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
