---
'@arki/mail': minor
---

Typed templates, honest transports, failover, durable send and a Dot plugin. Breaking: the client API is replaced.

- `mailer({ transport, from, redirectTo?, onEvent? })` replaces `initEmails` and `createEmailClient`. It has `send(template, input, { to })`, `sendRaw(message)`, `compose` and `render`. A failed send returns `{ data: null, error }` with a stable `code` (`ARKI_MAIL_E001`–`E011`), `retryable` and `acceptance`.
- `defineTemplate({ name, input, subject, text, html? })` replaces `EmailBuilder`/`EmailProcedure`. `input` is any Standard Schema. Callers pass its input type, renderers get its output. `text` is required.
- Transports replace providers. `resend()`, `unosend()`, `cloudflare()` live under `@arki/mail/http/*`, and `ses()` under `@arki/mail/node/ses`. They never make up a message id: it is `null` when the service gives none.
- `failover([...])` replaces `quotaRouter`. When every transport is over quota, it sends nothing (`E004`); before, it sent anyway. A lone transport with a quota now obeys it too. It moves to the next transport only when a provider clearly refused the mail. After a timeout it does not, because a second provider would send a duplicate.
- `logTransport()` replaces `isDev: true`.
- `@arki/mail/pg`: `mailOutbox({ mailer, tables })` queues a mail as a journal queue row inside the caller's transaction. The journal worker sends, retries and dead-letters it. `@arki/mail/pg/testing` has `mailQueueAssertions`.
- `@arki/mail/dot`: `mail(options | () => options)`, `mailOutboxPlugin({ tables })` and `mailJobs()` for `journalWorker({ jobs })`.
- `@arki/mail/testing`: `mailSink()` and `transportContract()`. `@arki/mail/templates/auth`: `magicLink`, `verifyEmail`, `resetPassword` and `signInCode`.
- Removed: `send(apiKey, payload)`, `createEmailClient`, `EmailClientConfigSchema`, the quota constants, `SendEmailPayload.react` and `scheduledAt`. Zod is no longer a runtime dependency.
