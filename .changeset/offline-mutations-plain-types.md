---
"@arki/offline": minor
---

`QueuedMutation`, `QueueErrorCode`, `EnqueueReceipt` and `DeadLetterEntry` in `@arki/offline/mutations` are now plain TS types (same shapes), and the stored-value schemas are internal, so `./mutations` and `./preset` name no Zod types.
