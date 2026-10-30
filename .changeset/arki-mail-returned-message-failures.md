---
'@arki/mail': minor
---

A message built from user-typed text, a hung service and a caller's cancel are told apart. Breaking in 0.x.

- `checkMessage`, and so `send`, `sendRaw`, `compose` and `enqueue`, return `MailInvalidMessage` (`mail.invalid_message`) for no recipient, an empty address, a line break in an address, subject or header, or a reserved header. They no longer throw `ARKI_MAIL_E002`; `E002` now means only "a queued mail without exactly one `to`". `SendFailure` gains it; `sendRaw` returns `SendRawFailure`.
- `enqueue` returns `MailTooLarge` (`mail.too_large`) for a message over `maxBytes`, in place of throwing `E010`. `E010` now means only an unreadable stored row.
- Every HTTP transport and `ses` take `timeoutMs` (default 30 s) and run each request under it joined with the caller's signal. `MailUncertain.data.reason` says `cancelled`, `timeout`, `network` or `unreadable`.
- `MailRejected.data.retryAfterMs` carries the service's `Retry-After`; the outbox waits at least that long before the next try.
- Service answers, queue rows and the KV counter are read with schemas. `narrow.ts` and the hand-written guards in `pg/args.ts` are gone; `mailMessageSchema` is locked to `MailMessage` by a type test.
