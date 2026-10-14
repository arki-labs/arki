---
'@arki/admin': minor
---

Execution receipts. Every execute now claims the permit's `executionId` in a `ReceiptStore` before the action runs and settles the receipt (`applied` with the result and its `sha256:` hash, or `failed` with the wire-safe error) before the response is sent. A repeated execute with the same id never runs the action again: it answers from the receipt, or `ARKI_ADMIN_E018` while the receipt is still `pending`; the same id on another action is refused (`E010`). The new `core.receipts` module serves `core.receipts.get({ executionId })` (scope `core:read`) so Foreman can settle a lost answer; `withCoreModules`, `createForemanHandlerFromEnv` and `foreman()` add it when given `receipts`. Two stores: `kvReceiptStore(kv)` on `@arki/kv` (`@arki/admin/receipts`, also re-exported from `./server`; TTL 30 days by default, never below Foreman's 5-minute receipt window) and `journalReceiptStore(...)` + `foremanReceiptTables()` on `@arki/journal` (new `@arki/admin/pg` entry; `@arki/journal` and `drizzle-orm` are optional peers).

Breaking: with `writes: 'on'` and no `receipts`, every execute is now refused with the new `ARKI_ADMIN_E017` (fail closed); a store that cannot take the claim is refused the same way, before the action runs. `ForemanEnv` now matches what `foremanEnvShape` parses to (every key optional), so an app passes its validated env as is.
