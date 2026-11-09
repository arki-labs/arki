---
"@arki/testing": minor
---

Unknown values are checked by schemas (A-39), and numbers the helpers cannot honour are the invariant failure `ARKI_FAILURE_E008` before any work runs.

- `isTimestamp`, `assertTimestamps`, `assertPaginationValid`, `assertDeepPartialMatch`, `assertArraySorted`, the stack manifest and the Ollama answer shapes use zod schemas. New type `PaginatedResponse` (what `assertPaginationValid` narrows to); `Timestamp`, `Verdict` and `CheckedClaim` are now inferred from their schemas (same shape; `Verdict` and `CheckedClaim` fields are no longer `readonly`).
- `assertPaginationValid` now checks `total`, `nextCursor` and `hasMore` types whenever they are present. `assertArraySorted` refuses `NaN` and an `Invalid Date` key instead of passing.
- `epochNanoseconds` / `epochMilliseconds` of an `Invalid Date` throw the invariant failure (was a raw `RangeError` from `BigInt(NaN)`).
- Invariant failure for: `createMany` count not a whole number ≥ 0; `measurePerformance`, `assertPerformance` and the tracker's `measure` `maxMs` not finite ≥ 0; `benchmarkQuery` / `comparePerformance` iterations not a whole number ≥ 1, and `comparePerformance` with no operations (was a raw `TypeError`); `assertTimestampRecent` `withinSeconds` not finite ≥ 0; `createJudge` / `createEmbedder` `timeoutMs` not a whole number from 1 to 2^31 - 1, `seed` not whole, `maxTokens` not ≥ 1 (a bad timeout read as `OllamaUnavailable`); `mailbox().waitFor` `timeoutMs` not finite ≥ 0; `dumpTable` `limit` not a whole number ≥ 0.
- `e2eTest` `cron.run` reports a failed status as `CRON_FAILED` before reading the body, and a body that is not JSON as `CRON_BAD_BODY` (was a raw `SyntaxError`).
