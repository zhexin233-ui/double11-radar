import type { ReactNode } from "react";

/**
 * 页眉：单页唯一 h1、可选说明与主要操作。
 *
 * 只负责展示；不包含数据加载或业务状态。
 */
export function PageHeader(props: {
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <h1>{props.title}</h1>
      {props.lead ? <p className="lead">{props.lead}</p> : null}
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
      {props.children}
    </header>
  );
}
