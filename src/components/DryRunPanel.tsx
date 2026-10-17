"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { EVALUATION_LABELS, type DryRunResultDto } from "@/components/api-types";
import { Section } from "@/components/ui/Section";
import { TableScroll } from "@/components/ui/TableScroll";
import { Feedback } from "@/components/ui/Feedback";
import { StatusBadge } from "@/components/status-badge";

/**
 * 需求试判面板（仅验收用）。
 *
 * 用与生产完全相同的 questions/解析链路调真实 Jev，但不写判断记录、不发通知。
 */

const EXAMPLES = [
  { label: "正例：抽纸", title: "心相印超韧抽纸 24包", content: "心相印超韧抽纸 24包 9.9元包邮" },
  { label: "正例：软抽", title: "维达软抽家庭装 6包", content: "维达软抽家庭装 6包 19.9元" },
  { label: "反例：湿巾", title: "心相印湿巾80片", content: "心相印湿巾80片 9.9元" },
  { label: "反例：卷纸", title: "心相印卷纸12卷", content: "心相印卷纸12卷 19.9元" },
  { label: "待确认：只有品牌", title: "心相印9.9元", content: "心相印9.9元" },
];

function formatProbabilities(value: Record<string, number> | null): string {
  if (!value) return "—";
  return Object.entries(value)
    .map(([key, score]) => `${key}=${score}`)
    .join("，");
}

export function DryRunPanel() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [mall, setMall] = useState("");
  const [price, setPrice] = useState("");
  const [result, setResult] = useState<DryRunResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const priceValue = price.trim() === "" ? null : Number(price);
      setResult(
        await apiSend<DryRunResultDto>("/api/settings/jev/dry-run", "POST", {
          title,
          content: content || undefined,
          category: category || undefined,
          brand: brand || undefined,
          mall: mall || undefined,
          price: priceValue !== null && Number.isFinite(priceValue) ? priceValue : null,
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="jev-dry-run"
      className="anchor-target"
      title="需求试判（仅验收用）"
      description={
        <>
          粘贴一段线报样例，用与生产相同的问题与解析逻辑调用真实 Jev，
          逐需求显示三态结果。<strong>不会写入判断记录，也不会发送任何通知</strong>；
          真实线报只能被动等待，这个入口用于立即验证语义正反例。
        </>
      }
    >
      <div className="stack">
        <div className="row small">
          {EXAMPLES.map((example) => (
            <Button
              key={example.label}
              type="button"
              variant="default"
              size="sm"
              onClick={() => {
                setTitle(example.title);
                setContent(example.content);
                setResult(null);
                setError(null);
              }}
            >
              {example.label}
            </Button>
          ))}
        </div>

        <form className="stack" onSubmit={run}>
          <label className="field">
            线报标题（必填）
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={500}
              required
            />
          </label>
          <label className="field">
            正文（可选）
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={3}
              maxLength={5000}
            />
          </label>
          <div className="grid-2">
            <label className="field">
              品类（可选）
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              />
            </label>
            <label className="field">
              品牌（可选）
              <input value={brand} onChange={(event) => setBrand(event.target.value)} />
            </label>
            <label className="field">
              商城（可选）
              <input value={mall} onChange={(event) => setMall(event.target.value)} />
            </label>
            <label className="field">
              价格（可选，留空表示来源未提供）
              <input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              运行试判
            </Button>
            <span className="muted small">
              价格留空会作为「来源未提供」传入，不会被当成 0 元。
            </span>
          </div>
        </form>

        {error ? <Feedback kind="error">试判失败：{error}</Feedback> : null}

        {result ? (
          result.needsCount === 0 ? (
            <Feedback kind="notice">
              还没有启用的需求，请先在「需求清单」中添加并启用。
            </Feedback>
          ) : (
            <div className="stack">
              <p className="muted small" style={{ margin: 0 }}>
                使用模型 {result.model || "—"}，规则版本 {result.ruleVersion}，配置版本{" "}
                {result.configVersion}，共 {result.needsCount} 个启用需求。
              </p>
              <TableScroll label="需求试判结果" minTableWidth={820}>
                <table>
                  <thead>
                    <tr>
                      <th>需求</th>
                      <th>结果</th>
                      <th>置信度</th>
                      <th>概率</th>
                      <th>说明 / 错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.results.map((item) => (
                      <tr key={item.needId}>
                        <td>
                          {item.needName}
                          {item.needNote ? (
                            <div className="muted small">备注：{item.needNote}</div>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge status={item.result}>
                            {EVALUATION_LABELS[item.result]}
                          </StatusBadge>
                        </td>
                        <td className="small">{item.confidence ?? "—"}</td>
                        <td className="small">{formatProbabilities(item.probabilities)}</td>
                        <td className="small error">{item.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          )
        ) : null}
      </div>
    </Section>
  );
}
