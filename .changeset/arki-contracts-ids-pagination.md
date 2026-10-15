---
'@arki/contracts': minor
---

Adds prefixed ids declared once and keyset pagination schemas (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`, phase 1c). Both are browser-safe (zod only).

- `defineId('sty_')` returns `{ prefix, schema, create, is }`; `IdOf<typeof storyId>` is `` `sty_${string}` ``. The schema is a zod template literal (it exports a JSON Schema pattern); `create()` makes `prefix + 24` cuid2-shaped characters with Web Crypto. Prefixes are kept exactly as given, so stored ids stay valid. `assertUniqueIdPrefixes(...ids)` rejects a repeated prefix at compile time and runtime, and a prefix that starts another at runtime.
- `keyset({ createdAt: 'desc', id: 'desc' })` declares a list order and its opaque base64url cursor (`encode`, `decode`, `cursor` schema; dates round-trip as dates). `pageInput(keyset, { defaultLimit, maxLimit })` and `page(itemSchema)` are the contract's input and output; `@arki/db/pagination` builds the query from the same declaration.
