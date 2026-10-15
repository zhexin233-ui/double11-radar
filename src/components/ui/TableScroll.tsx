import type { CSSProperties, ReactNode } from "react";

/**
 * 可访问的横向滚动容器：宽表只在自身内部滚动，不撑破整页。
 *
 * `role="region"` + `aria-label` 让读屏用户知道这是一个可滚动的命名区域，
 * `tabIndex={0}` 使其可获得键盘焦点并用方向键滚动。
 *
 * `minTableWidth` 控制表格的最小宽度（默认 720px）：窄屏下表格保持可读的列宽
 * 并横向滚动，而不是被压成一列一字。
 */
export function TableScroll(props: {
  label: string;
  children: ReactNode;
  minTableWidth?: number;
  className?: string;
}) {
  const style = props.minTableWidth
    ? ({ "--table-min": `${props.minTableWidth}px` } as CSSProperties)
    : undefined;

  return (
    <div
      className={["table-scroll", props.className].filter(Boolean).join(" ")}
      style={style}
      role="region"
      aria-label={props.label}
      tabIndex={0}
    >
      {props.children}
    </div>
  );
}
