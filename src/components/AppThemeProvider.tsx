"use client";

import type { ReactNode } from "react";
import { MantineProvider } from "@mantine/core";
import { editorialCssVariablesResolver, theme } from "@/theme";

/**
 * 客户端主题承载组件：
 * `cssVariablesResolver` 为函数，必须留在客户端边界内传给 `MantineProvider`，
 * 避免 Next.js App Router 服务端布局序列化函数报错。
 */
export function AppThemeProvider(props: { children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={editorialCssVariablesResolver}
      defaultColorScheme="auto"
    >
      {props.children}
    </MantineProvider>
  );
}
