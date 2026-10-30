---
'@arki/live': minor
---

`parseLiveEvent` and `parseLiveCursor` return a `schema.invalid_input` failure for a bad value instead of `undefined`. `awaitTxId` resolves a `live.receipt_timeout` failure on timeout instead of rejecting with E006 (`ReceiptTimeout` is exported). `touch()` falls back to a table-wide hint for a bad row key instead of throwing inside the caller's transaction. The client logs the error of a throwing `onEvent` on every failed attempt. `@arki/failure` is now a dependency.
