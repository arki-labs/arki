---
"@arki/mail": minor
---

A lone surrogate (such as `'\ud800'` alone) in any field of a message is `MailInvalidMessage`, like a NUL character: it is not text, and the outbox's jsonb column refused it with a raw Postgres 22P02. `enqueue` also returns `MailInvalidMessage` for an `idempotencyKey` holding a lone surrogate (the driver stored it as U+FFFD, so two keys shared one dedupe slot) and for an `expiresAt` that is an Invalid Date (was a raw `RangeError`).

Breaking: `send` and `sendRaw` now return `MailInvalidMessage` for a message with a lone surrogate instead of sending it.
