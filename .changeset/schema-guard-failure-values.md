---
'@arki/failure': minor
'@arki/schema': patch
---

Fix: `is`, `assert` and `ensure` now answer about a value that is itself a failure. Before, `is(failureValue, recordSchema)` returned `false` for an invalid-input failure and threw for any other failure, because `parse` returns a failure-valued output and a rejection the same way. `@arki/failure/schema` now exports `executeSchema`, which runs a schema once without unwrapping (`{ value }` or a failure), and the throwing channel is built on it.
