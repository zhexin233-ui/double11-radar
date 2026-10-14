import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "线报需求匹配与推送",
  description: "本地 NAS 上运行的线报语义匹配与通知服务",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
