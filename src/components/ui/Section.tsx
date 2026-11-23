import type { ReactNode } from "react";

/**
 * 内容区块：
 * - 默认：顶部发丝线 + 区块标题
 * - `alt`：纯净纸面容器（1px 边框 + 极轻层次）
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
        <p className="section-desc">{props.description}</p>
      ) : null}
      {props.children}
    </section>
  );
}
