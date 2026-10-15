import type { ReactNode } from "react";

/**
 * 统一反馈：加载 / 成功 / 失败 / 提示。
 *
 * - 失败使用 `role="alert"`，操作失败可被立即感知；
 * - 成功与加载使用礼貌 live region，避免打断；
 * - 只做展示，调用方负责传入文案。
 */
export function Feedback(props: {
  kind: "loading" | "success" | "error" | "notice";
  children: ReactNode;
}) {
  if (props.kind === "notice") {
    return (
      <p className="notice" role="status" aria-live="polite">
        {props.children}
      </p>
    );
  }

  const className = `feedback feedback-${props.kind}`;
  if (props.kind === "error") {
    return (
      <p className={className} role="alert">
        {props.children}
      </p>
    );
  }
  return (
    <p className={className} role="status" aria-live="polite">
      {props.children}
    </p>
  );
}
