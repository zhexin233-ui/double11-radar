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

## 三份客户端展示常量（2026-10 增补）

```ts
export const JEV_KEYS_PAGE_SIZE = 10;
export const JEV_USAGE_BY_KEY_PAGE_SIZE = 10;
export const JEV_USAGE_BY_KEY_PREVIEW = 5;
```

- 与 `NEEDS_PAGE_SIZE` 这类「镜像服务端 `*_LIST_DEFAULT_LIMIT`」的常量不同，这三个**没有服务端镜像**：
  `/api/settings/jev` 的 `keys` 与 `/api/settings/jev/usage` 的 `byKey` 都是**一次性完整数组**，
  没有 `limit` / `offset` / `total`。它们是纯前端分页展示参数，改它们不需要改服务端。
- 仍然必须放在 `api-types.ts`：组件里不允许出现分页魔法数字。
- 写新客户端分页列表时，同时检查：这个列表的 `total` 是不是真的由服务端给？如果不是（就是数组长度），
  它属于这一节，而不是 `_LIST_DEFAULT_LIMIT` 的镜像集。

> **Warning**: 图形上相似不等于同类。判断一个 `*_PAGE_SIZE` 是否属于「两边必须同步」的镜像集，
> 看服务端接口里有没有对应的分页参数，而不是看它的名字。

## 分页与列表枚的客户端契约（2026-10 增补）

```ts
export interface PagedItems<T> { items: T[]; total: number }
export const NEEDS_PAGE_SIZE = 10;
export const CHANNELS_PAGE_SIZE = 20;
```

- 页大小常量的服务端对应值在 `src/lib/domain/constants.ts`（`*_LIST_DEFAULT_LIMIT`）；客户端**不能**
  引 `@/lib`，所以这里是镜像常量。两边改动必须同步。
- 分页 `total` 的来源固定：`/api/bulletins.total`、`/api/needs.total`、`/api/channels.stats.total`、
  `/api/settings/jev/usage.recent.total`。**不在这份名单里的列表没有服务端分页**：
  `/api/settings/jev.keys` 与 `usage.byKey` 是客户端分页（`JEV_KEYS_PAGE_SIZE` /
  `JEV_USAGE_BY_KEY_PAGE_SIZE`，见上节）。
- `/api/channels` **没有** `total` 字段：总数一律取 `stats.total`（两者同义，重复字段会漂移）。
- `/api/status` 的 `counts.delivery` 是用字符串作键的聚合计数，展示时必须走 `deliveryLabel(status)`；
  未知状态原样返回，不得伪装成已知状态。

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
