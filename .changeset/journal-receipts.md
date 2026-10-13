---
'@arki/journal': minor
---

Idempotent commands. `journal.run`, a bound runner, a command's `run` and an effect's `ctx.run` take `{ idempotencyKey }`. The first run records key, command, input and result in the new `journal_receipts` table inside its transaction; a repeat with the same key and input returns the stored result without running the handler; another input or command is `CONFLICT`; a result that does not survive JSON fails with `UNSTABLE_SCHEMA`. `journal.pruneReceipts(db, { before })` deletes old receipts.

Schema change, additive: new table `journal_receipts`.
