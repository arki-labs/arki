---
'@arki/db': minor
---

A browser-safe `@arki/db/contract` entry, so an oRPC contract that ships to the browser never bundles drizzle-orm or a Postgres driver. It holds `TRANSACTION_FAILURES`, the six transaction failures (`TransactionConflict`, `TransactionUnavailable`, `TransactionRejected`, `TransactionCommitUncertain`, `TransactionCancelled`, `TransactionDefect`) and the type `TransactionFailure`. Ids for a contract come from `defineId` in `@arki/contracts`.
