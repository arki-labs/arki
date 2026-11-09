---
"@arki/mail": minor
---

`mailOutbox().enqueue` no longer fails the caller's write with a raw Postgres error on user data. It returns `MailInvalidMessage` and queues nothing when:

- any field of the rendered mail holds a NUL character (U+0000), which the jsonb row refuses (SQLSTATE 22P05);
- the `idempotencyKey` is empty, holds a NUL character (22021), or is over 256 characters (22001, the journal's `dedupe_key varchar(256)`), counted in code points.

Breaking: `send`, `sendRaw` and `compose` also return `MailInvalidMessage` for a NUL character in any field, so `send` and `enqueue` agree. No mail can carry it.
