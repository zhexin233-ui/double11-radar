"use client";

import type { ReactNode } from "react";

type StatusTone = "ok" | "warn" | "err" | "neutral";

/**
 * 状态徽标：**唯一的**「状态 → 语义色调」映射。
 *
 * 文案仍由调用方传入 `STATUS_LABELS` / `EVALUATION_LABELS` / `DELIVERY_LABELS`，
 * 本组件不复制任何文案映射，避免出现第二套状态语义。
 */
const STATUS_TONES: Record<string, StatusTone> = {
  matched: "ok",
  succeeded: "ok",
  uncertain: "warn",
  pending: "warn",
  failed: "err",
  disabled: "err",
  baseline: "neutral",
  not_matched: "neutral",
  sending: "neutral",
};

export function StatusBadge(props: { status: string; children: ReactNode }) {
  const tone = STATUS_TONES[props.status] ?? "neutral";
  return (
    <span className="status-pill" data-tone={tone}>
      <span className="status-pill-dot" aria-hidden="true" />
      <span>{props.children}</span>
    </span>
  );
}
