import type { ReactNode } from "react";

/**
 * 内容区块：白色/浅灰面板 + 区块标题 + 可选说明与操作。
 *
 * 只负责展示；不包含数据加载或业务状态。
 */
export function Section(props: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  id?: string;
  alt?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const classes = ["section"];
  if (props.alt) classes.push("section-alt");
  if (props.className) classes.push(props.className);

  return (
    <section className={classes.join(" ")} id={props.id}>
      {props.title || props.actions ? (
        <div className="section-head">
          {props.title ? <Heading>{props.title}</Heading> : <span />}
          {props.actions ? (
            <div className="section-actions">{props.actions}</div>
          ) : null}
        </div>
      ) : null}
      {props.description ? (
        <p className="muted small reading">{props.description}</p>
      ) : null}
      {props.children}
    </section>
  );
}
