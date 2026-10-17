# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code - does it already exist?

---

## The Problem

**Duplicated code is the #1 source of inconsistency bugs.**

When you copy-paste or rewrite existing logic:
- Bug fixes don't propagate
- Behavior diverges over time
- Codebase becomes harder to understand

---

## Before Writing New Code

### Step 1: Search First

```bash
# Search for similar function names
grep -r "functionName" .

# Search for similar logic
grep -r "keyword" .
```

### Step 2: Ask These Questions

| Question | If Yes... |
|----------|-----------|
| Does a similar function exist? | Use or extend it |
| Is this pattern used elsewhere? | Follow the existing pattern |
| Could this be a shared utility? | Create it in the right place |
| Am I copying code from another file? | **STOP** - extract to shared |

---

## Common Duplication Patterns

### Pattern 1: Copy-Paste Functions

**Bad**: Copying a validation function to another file

**Good**: Extract to shared utilities, import where needed

### Pattern 2: Similar Components

**Bad**: Creating a new component that's 80% similar to existing

**Good**: Extend existing component with props/variants

### Pattern 3: Repeated Constants

**Bad**: Defining the same constant in multiple files

**Good**: Single source of truth, import everywhere

### Pattern 4: Repeated Payload Field Extraction

**Bad**: Multiple consumers cast the same payload fields locally:

```typescript
// a page or component re-declaring the wire shape
const status = (item as { status?: string }).status;
const price = (item as { price?: number }).price;
```

This is duplicated contract logic even when the code is only two lines. Each
consumer now has its own definition of what a valid payload means.

**Good**: Put the decoder, type guard, or projection next to the data owner:

```typescript
// decoding belongs to the adapter: src/lib/sources/xianbao/normalize.ts
// projection belongs to the service: src/lib/service/bulletins.ts
// the page only reads the mirrored DTO from src/components/api-types.ts
{STATUS_LABELS[detail.status]}
```

**Rule**: If the same untyped payload field is read in 2+ places, create a
shared type guard / normalizer / projection before adding a third reader.

---

## When to Abstract

**Abstract when**:
- Same code appears 3+ times
- Logic is complex enough to have bugs
- Multiple people might need this

**Don't abstract when**:
- Only used once
- Trivial one-liner
- Abstraction would be more complex than duplication

---

## After Batch Modifications

When you've made similar changes to multiple files:

1. **Review**: Did you catch all instances?
2. **Search**: Run grep to find any missed
3. **Consider**: Should this be abstracted?

### One Switch Per Status Enum

When state is derived from a status-like value (`status`, `result`, `purpose`), prefer one
`switch` / one lookup map over scattered `if/else` branches.

```typescript
// BAD - the mapping is spread across pages and drifts
if (status === "matched") return "已匹配";
else if (status === "uncertain") return "待确认";
else if (status === "failed") return "处理失败";

// GOOD - one map owns the mapping, pages import it
// src/components/api-types.ts -> STATUS_LABELS
{STATUS_LABELS[detail.status]}
```

This matters because the status vocabulary is a shared contract: the server's
`evaluations.result` / `jev_requests.status` decide which labels exist, and
`STATUS_LABELS` / `JE_REQUEST_STATUS_LABELS` are the only places that translate
them. A page-level `if/else` chain is a second copy of that contract.

### One Formatter Per Display Concern

The same rule applies to display formatters, not just label maps. A formatter that
is copy-pasted into every page is a second contract: fix the `null` handling in one
copy and the others still render `Invalid Date`.

**Current state (2026-10)**: `formatTime(value: string | null)` is declared **locally in 6 places**
(`bulletins/page.tsx`、`bulletins/[id]/page.tsx`、`needs/page.tsx`、`status/page.tsx`、`channels/page.tsx`
和 `jev/page.tsx` 里那个内联版本). During the `jev-keys-modal-pagination` task the jev scope was
unified onto `src/components/format.ts`:

```ts
// src/components/format.ts —— 新增格式化器放这里，不要在新页面里再抄一份
import { formatTime } from "@/components/format";
```

The other five copies are **known, deliberate** debt (that task's scope was jev-only).
When you next touch a page that uses a local `formatTime`, migrate that page to the import
instead of copying the body again — do not bundle the remaining five into an unrelated task.

---

## Checklist Before Commit

- [ ] Searched for existing similar code
- [ ] No copy-pasted logic that should be shared
- [ ] No repeated untyped payload field extraction outside a shared decoder
- [ ] Constants defined in one place
- [ ] Similar patterns follow same structure
- [ ] Status/purpose label text lives in one shared map, not in a page

---

## This Repo: The Client/Server Constant Boundary

`src/components/api-types.ts` is the client-side contract and **imports nothing from `src/lib/**`**
(those modules are server-only). When a knob is needed on both sides, the constant deliberately
exists twice:

| Constant | Server | Client |
| --- | --- | --- |
| `JE_KEY_FAILURE_THRESHOLD = 3` | `src/lib/db/repos/jev-keys.ts:19` | `src/components/api-types.ts:87` |
| page size `50` | `src/lib/service/bulletins.ts:107` (`BULLETIN_LIST_DEFAULT_LIMIT`) | `src/components/api-types.ts:313` (`BULLETIN_PAGE_SIZE`) |

**Prevention**: unlike a normal shared constant, no compiler error catches the drift. Before
changing one, grep the name *and* the value on both sides:

```bash
grep -rn "JE_KEY_FAILURE_THRESHOLD" src/
grep -rn "= 50;" src/lib src/components
```

## This Repo: One Label Map Per Enum

User-facing text for a status/purpose enum belongs in exactly one map:

| Map | Location | Consumed by |
| --- | --- | --- |
| `STATUS_LABELS` | `src/components/api-types.ts:282` | bulletins list + detail pages |
| `JE_PURPOSE_LABELS` | `src/lib/service/jev-usage.ts:23` | Jev usage projection |
| `JE_REQUEST_STATUS_LABELS` | `src/lib/service/jev-usage.ts:29` | Jev usage projection |

**Prevention**: never inline a `status === "failed" ? "处理失败" : ...` chain in a page — that is
how 「明确匹配」/「待确认（信息不足）」/「处理失败」/「没有匹配」 drift apart between screens.
