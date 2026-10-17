---
'@arki/mail': minor
---

A mail that is not sent is a returned failure from `@arki/failure`, not a `{ data, error }` result. `send`, `sendRaw`, `compose`, `render`, `renderTemplate` and every transport return the success value itself (`SentMail`, `MailMessage`, `MailContent`) or one of these failures, all exported from `@arki/mail`:

- `MailInvalidInput` (`mail.invalid_input`, 422): the template's schema refused the input. `data`: `template`, `issues` (`{ path, message }`, plain keys).
- `MailQuotaExhausted` (`mail.quota_exhausted`, 429): every transport is over its quota. `data`: `month`.
- `MailRejected` (`mail.rejected`, 422): the service refused the mail. `data`: `transport`, `retryable` (429 and 5xx), `upstreamStatus`, `providerCode`, `detail`.
- `MailUncertain` (`mail.uncertain`, 503): no readable answer (a timeout, a network failure, or a 2xx that could not be read), so the service may have taken the mail. `data`: `transport`, `detail`, `upstreamStatus`.
- `MailExpired` (`mail.expired`, 410): a queued mail passed its `expiresAt`. `data`: `expiresAt`.

Breaking:

- `MailResult` and `MailFailure` are removed. Check a result with `isFailure` or a definition's `is` (`MailRejected.is(sent)`). `acceptance` is gone: `MailRejected` means the service did not take the mail, `MailUncertain` that it may have.
- `ARKI_MAIL_E003`, `E004`, `E006`, `E007`, `E008` and `E011` are removed from `MAIL_ERROR_CODES`; `E008` (an unreadable answer) is now `MailUncertain`. `MailError` is only for misuse and is now built as `new MailError(code, message, options?)`; it no longer has `retryable`, `acceptance` or `failure`.
- Misuse now throws `MailError` instead of being returned: `E002` (no recipient, a line break in a header or address, a reserved header), `E005` (a field the transport cannot carry, before any request) and `E001` when the SES SDK cannot load. The mailer passes a thrown `MailError` on; any other throw from a transport is still `MailUncertain`.
- `mailSink().failNext(failure?)` takes a failure value, such as `MailRejected({ transport: 'sink', retryable: true })`; the default is a `MailRejected` that is not retryable.
- `mailOutbox().enqueue` returns `MailInvalidInput` for bad input and queues nothing, instead of throwing `E003`. The runner retries only `MailUncertain` and a `MailRejected` with `data.retryable`; every other failure, and every `MailError`, is dead on its first try.
- `zod` is now a dependency (the failures' data schemas).
