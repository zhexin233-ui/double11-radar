# Type Safety

> How the client talks to the server without leaking server code.

---

## The boundary

Client components may not import `@/lib/**`. `src/components/api-types.ts` mirrors the JSON shapes
the API actually returns:

```ts
export interface ChannelDto { id: string; origin: "feed" | "zdm"; /* ... */ }
export interface SecretStateDto { configured: boolean; masked: string | null; unreadable: boolean }
export function apiGet<T>(path: string): Promise<T>;
export function apiSend<T>(path: string, method: "POST"|"PUT"|"PATCH"|"DELETE", json?: unknown): Promise<T>;
```

Generic type parameters come from the call site, so a response shape change must be applied in
exactly two places: the server projection and `api-types.ts`.

## Rules

1. Union types mirror the database values exactly, including the failure states:
   `"baseline" | "pending" | "matched" | "failed" | "uncertain" | "not_matched"`.
2. Optional server fields are `| null`, never `?`, matching the JSON contract.
3. Use `unknown` for request bodies and let the server validate with zod; the client does not
   re-derive validation rules.
4. Never assert `as` on a fetched value. If `apiGet<T>` is insufficient, extend `api-types.ts`.

## Jev Key / 用量 / 记录筛选 DTO（`src/components/api-types.ts`）

Key 池、费用统计与记录页筛选的客户端契约集中在 `api-types.ts`：

- `JevKeyDto`：`id` / `label` / `generation` / `enabled` / `disabledReason` /
  `consecutiveFailures` / `lastError` / `lastUsedAt` / `createdAt` / `updatedAt` / `secretState`，
  **绝不含明文**。
- `JevSettingsDto extends JevConfigDto`：额外 `keys: JevKeyDto[]`；`apiKey` 仍是兼容掩码。
- `JevUsageDto` = `{ summary; byKey; recent }`：`summary` / `byKey` 同时给整数纳美元
  （`knownCostNanos` 等）与格式化美元（`knownCostUsd`）；每条 `recent` 记录含 `estimatedUsd`
  字符串，未知为 `null`。
- `JevRequestStatusDto` / `JevCostStatusDto` / `JevRequestPurposeDto` 与服务端枚举一致
  （`in_flight|succeeded|failed|interrupted` / `known|unknown` / `evaluate|test|dry_run`）。
- `BulletinFilterStatusDto` 与仓库层 `BULLETIN_FILTER_STATUSES` / `isBulletinFilterStatus` 接受
  的值一一对应，不含 `baseline`；`BULLETIN_FILTER_OPTIONS` = 全部 + 五种非基线状态。
- 常量：`BULLETIN_PAGE_SIZE = 50`、`BULLETIN_AUTO_REFRESH_MS = 5000`、
  `JE_KEY_FAILURE_THRESHOLD = 3`。

> **Warning**: 金额一律用 `estimatedUsd` / `knownCostUsd` 字符串展示，未知为 `null`，
> **绝不显示为 $0.00**（极小正费用也必须可见）。状态/筛选枚举不要在组件里另写一套映射，
> 直接复用 `api-types.ts` 的 DTO 与常量。

## Gotcha

> `SecretStateDto.unreadable` exists because a rotated `APP_ENCRYPTION_KEY` makes stored secrets
> undecryptable. The server reports that state instead of returning 500, so the UI must render
> 「无法解密（加密密钥可能已变更）」 rather than the masked value.

## Wrong vs Correct

```tsx
// Wrong: local re-definition of the contract inside a component
const price = (item as { price?: number }).price ?? 0;      // invents 0 for "no price"
```

```tsx
// Correct: typed DTO + explicit null handling
const price: number | null = item.bulletin.price;
{price === null ? "" : `${price} 元`}
```

## 三模式配置与处理来源 DTO（`src/components/api-types.ts`）

`JevConfigDto.config` 额外镜像 `evaluationMode: EvaluationModeDto` 与 `regexRules: string[]`；
`BulletinDetailDto.processing` 镜像服务端 `BulletinProcessingView`：

- `EvaluationModeDto = "individual" | "batch_gate" | "regex_gate"` 与服务端 `EvaluationMode` 一致；
  选项与取舍文案集中在 `EVALUATION_MODE_OPTIONS` / `EVALUATION_MODE_LABELS`，组件不得另写一套映射。
- `ProcessingStageDto` / `ScreeningSourceDto` 镜像 `ProcessingStage` / `ScreeningSource`；
  `PROCESSING_SOURCE_LABELS` 是「批次预筛排除 / 正则过滤」的唯一文案来源。
- `JevRequestPurposeDto` 必须包含 `batch_gate`；`JevUsageRequestDto` 额外含 `evaluationRunId` / `batchPartId`。
- 上限常量 `MAX_REGEX_RULES` / `MAX_REGEX_RULE_LENGTH` / `MAX_REGEX_TOTAL_BYTES` 只作输入提示，
  服务端 `src/lib/domain/constants.ts` 是唯一权威。

> **Warning**: 本地过滤（`processing.stage === "filtered"`）在列表归入 `not_matched`，
> 但详情必须显示 `screeningReason`（如「正则规则未匹配，未调用 JEV」/「由批次预筛判定」），
> 不得渲染为模型逐条结论，也不得显示虚构概率。
