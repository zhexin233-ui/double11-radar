import { createTheme } from "@mantine/core";

/**
 * 全局主题。
 *
 * 只设置「主色 + 圆角 + 指针 + 字体」四件事：
 * - 主色单一来源（blue），自有 `--accent` 直接别名到 Mantine 的主色变量，
 *   避免出现两套蓝；编辑式的层级感靠排版（字号 / 字距 / 分割线）实现，不靠颜色堆叠。
 * - `defaultColorScheme="auto"` 在根布局传入，首次访问跟随系统。
 */
export const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
  cursorType: "pointer",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
});
