import type { Metadata } from "next";
import "@mantine/core/styles.css";
import "./globals.css";
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";
import { theme } from "@/theme";

export const metadata: Metadata = {
  title: "线报需求匹配与推送",
  description: "本地 NAS 上运行的线报语义匹配与通知服务",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" {...mantineHtmlProps}>
      <head>
        {/* 首帧前写入 data-mantine-color-scheme，避免刷新时闪白屏。 */}
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
