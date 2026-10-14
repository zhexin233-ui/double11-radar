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
