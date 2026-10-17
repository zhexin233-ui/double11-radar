import type { ReactNode } from "react";
import { Alert, Loader } from "@mantine/core";

/**
 * 统一反馈：加载 / 成功 / 失败 / 提示。
 *
 * - 失败使用 `role="alert"`，操作失败可被立即感知；
 * - 成功、加载与提示使用 `role="status"` + `aria-live="polite"`，避免打断；
 * - 视觉交给 Mantine `Alert`（浅色底，随主题适配），加载态附 `Loader`；
 * - 只做展示，调用方负责传入文案。
 */
const FEEDBACK_COLORS = {
  loading: "gray",
  success: "green",
  notice: "gray",
  error: "red",
} as const;

export function Feedback(props: {
  kind: "loading" | "success" | "error" | "notice";
  children: ReactNode;
}) {
  const isError = props.kind === "error";

  return (
    <Alert
      variant="light"
      color={FEEDBACK_COLORS[props.kind]}
      icon={props.kind === "loading" ? <Loader size="xs" color="gray" /> : undefined}
      role={isError ? "alert" : "status"}
      aria-live={isError ? undefined : "polite"}
    >
      {props.children}
    </Alert>
  );
}
