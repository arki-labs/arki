# @arki/emails

## 0.2.0

### Minor Changes

- 31ec526: Renamed from `@arki/emails` to `@arki/mail`. Import from `@arki/mail` and its subpaths instead; there is no compatibility package. The debug logger category is now `arki:mail` (`DEBUG=arki:mail`) and error messages start with `[arki/mail]`.
- 7c05d9a: Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
  schema output through `IdOf` and DB columns without changing stored strings.
  The one-argument declaration remains compatible. Migrate each domain and its
  consumers together using the canonical schema at raw boundaries.

  Replace Journal's private Cuid2 generation with modern, supervised declarations.
  Public `jobId`, Journal write/worker/workflow/operator methods, webhook scheduling,
  Queue outbox scheduling and Mail outbox scheduling can now return precise
  `IdGenerationFailure` outcomes. Handle returned failures before treating an
  operation as committed or acknowledged. Partial writes roll back and adapters
  preserve the original failure.

  Admin actions can declare canonical `failures` and infer their exact execute
  outcomes. Refusals produce failed receipts; undeclared or thrown failures are
  supervised without leaking private metadata. Receipt replay and clients support
  canonical server-error statuses. Dot outbox producers retain the complete
  scheduling outcome.

  See Contracts' `docs/upgrades/domain-ids.md` and Journal's
  `docs/upgrades/id-generation-failures.md` for migration details and remaining
  identity-branding scope.

- 4f074bd: Explicit client config. `createEmailClientFromEnv` is replaced by `createEmailClient(config)`, validated with Zod (`EmailClientConfigSchema`). The library no longer reads `process.env`: `isDev` is a required option (no `NODE_ENV` fallback), keys come only from the config, and missing or invalid config throws a clear error. `initEmails` defaults `isDev` to `false`; the deprecated `send(apiKey, payload)` now takes `{ isDev }`. Templates are renamed to neutral names (`arki-magic-link` to `magic-link`, `notion-magic-link` to `magic-link-minimal`) and the branded demo templates (stripe, vercel, plaid) are removed. `resend`, `@aws-sdk/client-sesv2` and `react-email` become optional peer dependencies, loaded on first use. `resend` providers no longer throw on network failure. Logger category is now `arki:mail`. Adds a shared provider contract test suite and a README with a provider table.
- 2c0b668: Make failure the acyclic validation foundation. Schema parsing now returns exact typed validation failures, and failure revival returns typed protocol/validator defects instead of throwing. Add validated versioned JSON envelopes; retain legacy envelope reads while rejecting non-JSON data and changing output transforms. oRPC error maps validate output-only wire data.

  Migrate consumers to check failures, propagate them through Journal event/write/replay and queue/mail operations, and use explicit exception bridges at foreign callbacks. Journal rejects invalid event entries before inserting them. See `@arki/failure/docs/upgrade-typed-validation.md` for breaking API and stored-data migration details.

- 71dea3e: Carry inferred failures through configure, boot, start, stop and dispose, with atomic service publication, rollback aggregation and supervised usecase invocation even without tracing. Configure now returns a typed outcome and remains synchronous with no I/O; logging activates during boot. Detached lifecycle callbacks must prove an undefined or concrete failure return rather than void.

  Breaking: check configure before accessing the manifest, inspect stop/dispose outcomes, and handle managed CLI preflight failures under `dot.preflight_failed` in `.error.data.{app,migrations,report,failure}` (exit 3). Successful JSON paths remain unchanged. See `docs/upgrade-phases.md` for phase-specific outcomes and migration steps.

  Cron oRPC adapters route canonical supervised defects through the existing failure policy before success mapping; business refusals keep their explicit responders.

  Database, mail, queue, resilience and Journal adapters retain their authored factory and lifecycle return types, including driver-specific service types.

- 195172e: A mail that is not sent is a returned failure from `@arki/failure`, not a `{ data, error }` result. `send`, `sendRaw`, `compose`, `render`, `renderTemplate` and every transport return the success value itself (`SentMail`, `MailMessage`, `MailContent`) or one of these failures, all exported from `@arki/mail`:

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
  - `SendFailure` (what `send` can return in place of a sent mail) and `TransportFailure` (what a transport can return) are exported from `@arki/mail`.

- f663cc9: Typed templates, honest transports, failover, durable send and a Dot plugin. Breaking: the client API is replaced.

  - `mailer({ transport, from, redirectTo?, onEvent? })` replaces `initEmails` and `createEmailClient`. It has `send(template, input, { to })`, `sendRaw(message)`, `compose` and `render`. A failed send returns `{ data: null, error }` with a stable `code` (`ARKI_MAIL_E001`–`E011`), `retryable` and `acceptance`.
  - `defineTemplate({ name, input, subject, text, html? })` replaces `EmailBuilder`/`EmailProcedure`. `input` is any Standard Schema. Callers pass its input type, renderers get its output. `text` is required.
  - Transports replace providers. `resend()`, `unosend()`, `cloudflare()` live under `@arki/mail/http/*`, and `ses()` under `@arki/mail/node/ses`. They never make up a message id: it is `null` when the service gives none.
  - `failover([...])` replaces `quotaRouter`. When every transport is over quota, it sends nothing (`E004`); before, it sent anyway. A lone transport with a quota now obeys it too. It moves to the next transport only when a provider clearly refused the mail. After a timeout it does not, because a second provider would send a duplicate.
  - `logTransport()` replaces `isDev: true`.
  - `@arki/mail/pg`: `mailOutbox({ mailer, tables })` queues a mail as a journal queue row inside the caller's transaction. The journal worker sends, retries and dead-letters it. `@arki/mail/pg/testing` has `mailQueueAssertions`.
  - `@arki/mail/dot`: `mail(options | () => options)`, `mailOutboxPlugin({ tables })` and `mailJobs()` for `journalWorker({ jobs })`.
  - `@arki/mail/testing`: `mailSink()` and `transportContract()`. `@arki/mail/templates/auth`: `magicLink`, `verifyEmail`, `resetPassword` and `signInCode`.
  - Removed: `send(apiKey, payload)`, `createEmailClient`, `EmailClientConfigSchema`, the quota constants, `SendEmailPayload.react` and `scheduledAt`. Zod is no longer a runtime dependency.

- 61f9592: Cloudflare Email Service driver error-semantics hardening: a send where every
  recipient permanently bounced (nothing delivered or queued) now returns an
  error (`CloudflareEmailServicePermanentBounce`) instead of a success with a
  synthetic empty id; a partial bounce (≥1 delivered/queued) remains a success
  and is now a documented contract; an HTTP error status with a parseable CF
  error body now surfaces the CF error message + code (e.g. `code=10004`
  rate-limit) instead of the bare `HTTP <status>`, so callers can classify
  retryability.

### Patch Changes

- cbefc52: Dot plugins no longer pass a hard-coded `version` (the field was removed from `@arki/dot`).
- e12e20a: Add `@arki/mail/http/mailpit`: a transport that sends through Mailpit's HTTP JSON API, so a test or a local run can read the mail an app really sent. Additive.
- fe5a391: README follows the docs standard (install, quick start, limits with the uncertain-delivery boundary, failure behaviour), with `AGENTS.md` and an Errors section in the agent guide. The `mail.*` failures and `ARKI_MAIL_E*` codes gain `@fix` and `@verify` tags.

  no demo impact: documentation and doc-example changes only, runtime behaviour unchanged

- Updated dependencies [36f1f54]
- Updated dependencies [38e4bd7]
- Updated dependencies [483a022]
- Updated dependencies [932c9e4]
- Updated dependencies [c3aeda9]
- Updated dependencies [d71ae60]
- Updated dependencies [3064b6a]
- Updated dependencies [7c05d9a]
- Updated dependencies [115aa87]
- Updated dependencies [851b41b]
- Updated dependencies [2c0b668]
- Updated dependencies [d80a024]
- Updated dependencies [71dea3e]
- Updated dependencies [9281865]
- Updated dependencies [536d17d]
- Updated dependencies [74f08e5]
- Updated dependencies [953991a]
- Updated dependencies [397d1e6]
- Updated dependencies [f2e9f69]
- Updated dependencies [fce3e8c]
- Updated dependencies [baecec3]
- Updated dependencies [5bc6390]
- Updated dependencies [713535d]
- Updated dependencies [2ce7fe2]
- Updated dependencies [baecec3]
- Updated dependencies [acf8c9f]
  - @arki/journal@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/log@1.0.0
