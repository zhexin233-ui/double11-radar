# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:

- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:

- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary              | Common Issues                     |
| --------------------- | --------------------------------- |
| API ↔ Service         | Type mismatches, missing fields   |
| Service ↔ Database    | Format conversions, null handling |
| Backend ↔ Frontend    | Serialization, date formats       |
| Component ↔ Component | Props shape changes               |

### Step 3: Define Contracts

For each boundary:

- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

### Mistake 4: Every Consumer Parses The Same Payload

**Bad**: A page reads a raw payload field and re-declares the contract locally:

```typescript
// a page or component reaching into the wire shape
const status = (item as { status?: BulletinDetailDto["status"] }).status;
const label = status === "failed" ? "处理失败" : "已匹配";
```

This looks local, but it means every consumer owns a private version of the
contract. The next field change updates the server and misses a page.

**Good**: The adapter decodes to a domain type once, the server projects it into a DTO, and the
client consumes the mirrored type:

```typescript
// src/lib/sources/xianbao/normalize.ts owns decoding from unknown -> NormalizedBulletin
// src/lib/service/bulletins.ts owns the projection row -> BulletinDetailDto
// src/components/api-types.ts mirrors the DTO; pages use apiGet<...> + STATUS_LABELS
{STATUS_LABELS[detail.status]}
```

**Rule**: For HTTP payloads, LLM responses, external feeds, or config files,
create one owner for:

- event / payload type definitions
- type guards and normalization from `unknown`
- metadata projections used by UI commands
- reducers that replay state from the source of truth

Rendering code may format fields, but it must not redefine the payload contract.

---

## Checklist for Cross-Layer Features

Before implementation:

- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:

- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip
- [ ] Checked that consumers import shared decoders / projections instead of
      casting payload fields locally
- [ ] Checked that derived state points back to the source event identifier
      (`seq`, `id`, `version`) instead of inventing a second cursor


---

## This Repo: The Five Boundaries

| Boundary | Contract owner | Enforced by |
| --- | --- | --- |
| External HTTP (线报酷 / Jev) → app | adapter-owned zod schema + typed error (`XianbaoError`, `JevError`) | `src/lib/sources/xianbao/*`, `src/lib/jev/*` |
| External HTTP (Bark / Feishu) → app | no exception, no zod — returns `SendResult` (`ok`/`retryable`/`error`) | `src/lib/notify/*` |
| DB column ↔ repo function | DDL in `src/lib/db/migrations.ts` | raw SQL in `src/lib/db/repos/*` |
| repo row ↔ service projection | service function returning a DTO | `src/lib/service/*.ts` |
| server DTO ↔ client type | hand-mirrored copy, **no imports** | `src/components/api-types.ts` |
| worker live state ↔ admin page | `settings('runtime')` | `src/lib/worker/runtime-state.ts` → `GET /api/status` |

## Checklist: Adding One Field To An Admin Page

- [ ] Column added as new DDL in `src/lib/db/migrations.ts` (never edit an applied migration)
- [ ] Repo function in `src/lib/db/repos/<table>.ts` reads/writes it (booleans as `0/1`)
- [ ] Service projection maps row → DTO, using `null` for unknown — never a plausible default
- [ ] DTO type **and** the mirrored type in `src/components/api-types.ts` both updated
- [ ] Route returns it via `ok(...)`; page reads it through `useApiResource` / `apiGet<T>`
- [ ] Missing value renders an explicit 「未知」/ `—`, never a fabricated number

## Real Examples In This Repo

- **Integer nanos, not floats**: `jev_requests.estimated_usd_nanos INTEGER`
  (`src/lib/db/migrations.ts:237`). Cost stays integer nanos through the DDL and repo layers and is
  formatted once at the display boundary — a float round-trip loses precision and the 费用估算
  then disagrees with itself between pages.
- **Boolean bind trap**: `better-sqlite3` throws on `boolean` bind parameters. Repos must convert
  to `0/1` at the boundary, otherwise the insert fails at runtime while `tsc` stays green.
- **Two id spaces, one article**: the 线报酷 `zhidemai` category stream and the `type=zdm`
  independent stream describe the same articles under two id spaces; the collector polls only one,
  or the same content is counted twice.
- **Client copy is not checked**: `src/components/api-types.ts` imports nothing from `src/lib/**`,
  so a server-side field rename compiles fine and breaks the page at runtime. This is the boundary
  most likely to drift — grep it.
