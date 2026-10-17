import { Fragment, type ReactNode } from "react";

/**
 * 编辑式条目列表的展示原语：只输出结构与类名，不接收 DTO。
 *
 * 视觉与分隔线由 `globals.css` 的 `.list*` / `.eyebrow` 类承担；
 * 页面负责组织条目内容（标题链接、元信息、行尾操作）。
 */

export function List(props: { children: ReactNode; className?: string }) {
  return (
    <ul className={["list", props.className].filter(Boolean).join(" ")}>
      {props.children}
    </ul>
  );
}

export function ListItem(props: { children: ReactNode; className?: string }) {
  return (
    <li className={["list-item", props.className].filter(Boolean).join(" ")}>
      {props.children}
    </li>
  );
}

/**
 * 小标签行：状态徽标 / 来源 / 时间等。
 *
 * 分隔点由 CSS 的 `.sep::before` 生成（`aria-hidden`，读屏不读它）。
 */
export function Eyebrow(props: {
  items: ReadonlyArray<ReactNode>;
  className?: string;
}) {
  return (
    <p className={["eyebrow", props.className].filter(Boolean).join(" ")}>
      {props.items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="sep" aria-hidden="true" /> : null}
          <span>{item}</span>
        </Fragment>
      ))}
    </p>
  );
}
