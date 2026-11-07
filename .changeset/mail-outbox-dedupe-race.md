---
'@arki/mail': minor
---

`mailOutbox.enqueue` no longer throws a plain `Error` when the job holding an idempotency key is sent and deleted between the refused insert and the lookup. The key is free then, so it inserts again and returns `{ jobId, deduped: false }`. If other writers keep taking the key for three tries in a row, it returns the new `MailEnqueueContended` (`mail.enqueue_contended`, 503, `data.attempts`) and queues nothing; retry the write. `MailTooLarge`, `MailInvalidMessage` and `MailEnqueueContended` are now exported from `@arki/mail`, so callers can branch on them with `.is()`.
