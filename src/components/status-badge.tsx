"use client";

import type { ReactNode } from "react";
import { Badge, type MantineColor } from "@mantine/core";

/**
 * 状态徽标：**唯一的**「状态 → 颜色」映射。
 *
 * 文案仍由调用方传入 `STATUS_LABELS` / `EVALUATION_LABELS` / `DELIVERY_LABELS`，
 * 本组件不复制任何文案映射，避免出现第二套状态语义。
 */
const STATUS_COLORS: Record<string, MantineColor> = {
  matched: "green",
  succeeded: "green",
  uncertain: "yellow",
  pending: "yellow",
  failed: "red",
  disabled: "red",
  baseline: "gray",
  not_matched: "gray",
  sending: "gray",
};

export function StatusBadge(props: { status: string; children: ReactNode }) {
  return (
    <Badge
      component="span"
      variant="light"
      color={STATUS_COLORS[props.status] ?? "gray"}
    >
      {props.children}
    </Badge>
  );
}
