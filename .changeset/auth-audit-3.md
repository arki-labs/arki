---
"@arki/auth": minor
---

`@arki/auth/testing/integration-tester`: the connection, event-store, id and page checks use schemas (A-39), and caller values the tester cannot honour are the invariant failure `ARKI_FAILURE_E008` before any work runs.

- `clearTables`, `clearAllTables`, `clearTablesExcept` and `clearTablesByPattern` refuse a set that leaves out a schema table referencing a cleared one (without `on delete cascade` / `set null`), naming it, before deleting any row (was a raw 23503 half-way through). `clearTablesByPattern` ignores a RegExp's `g` / `y` flags (they skipped tables) and refuses a string that is not a regular expression (was a raw `SyntaxError`).
- `generateBetween` takes whole numbers with `min <= max` (fractions and reversed bounds returned values outside the range); `generateDate` refuses an `Invalid Date` bound (was a raw `RangeError`), `from` after `to`, and a negative, non-finite or out-of-range span; `generateString` takes a length from 0 to 64 (longer was silently cut); `generateFromEnum` refuses an empty list (returned `undefined`); `waitForProjections` takes 0 to 2^31 - 1 ms.
- `assertPaginatedResponse` now delegates to `assertPaginationValid` from `@arki/testing` and narrows to its `PaginatedResponse`, so `total`, `nextCursor` and `hasMore` types are checked when present.
