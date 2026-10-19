# @arki/mail

Typed mail for TypeScript. Templates are plain objects typed by any Standard Schema. Transports never throw and never make up a message id. `failover` keeps to your quotas and never sends a mail twice to dodge a timeout. And `@arki/mail/pg` queues a mail in the same transaction as the write it belongs to.

## Install

```sh
bun add @arki/mail @arki/failure
```

`@arki/failure` gives you `isFailure`. A template's input schema comes from any Standard Schema library; the examples use `zod`.

## Quick start

```ts
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { defineTemplate, mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';

const welcome = defineTemplate({
  name: 'welcome',
  input: z.object({ name: z.string(), trialDays: z.number().default(14) }),
  subject: data => `Welcome, ${data.name}`,
  text: data => `Hi ${data.name}, your trial lasts ${data.trialDays} days.`,
});

const mail = mailer({
  transport: resend({ apiKey: process.env.RESEND_API_KEY ?? '' }),
  from: 'Acme <hello@acme.dev>',
});

const sent = await mail.send(welcome, { name: 'Ada' }, { to: 'ada@example.com' });
if (isFailure(sent)) console.error(sent.code, sent.message);
else console.info(sent.id);
```

`send` never throws for a mail that was not sent. It returns the `SentMail` itself, or a failure value from [`@arki/failure`](https://www.npmjs.com/package/@arki/failure): `MailInvalidInput`, `MailQuotaExhausted`, `MailRejected`, `MailUncertain` or canonical `ValidatorDefect` (see [Failure behaviour](#failure-behaviour)). `MailRejected` means the service surely did not take the mail, and its `data.retryable` says whether trying later can help. `MailUncertain` means it may have taken it anyway. Misuse throws `MailError`: an empty sender, a line break in a header, a field the transport cannot carry.

The sender comes from the call, then the template's `defaults.from`, then the mailer's `from`.

Two options guard non-production setups:

- `transport: logTransport()` sends nothing. It logs each mail at debug level and reports it as `simulated`.
- `redirectTo: 'staging@acme.dev'` sends every mail there instead, drops Cc and Bcc, and keeps the original To in `X-Original-To`.

`onEvent` observes `sending`, `sent` and `failed`. An observer that throws is logged; it never fails or repeats a send.

## When not to use this

- Bulk or marketing sends with lists, unsubscribes and open tracking. This package sends transactional mail.
- Reading or parsing inbound mail.
- A guarantee that a mail arrives exactly once. A send that times out may or may not have been delivered (see [Limits](#limits)).

## Runtime support

The core, `templates/auth` and the `http/*` transports use only `fetch` and run on Node, Bun and Deno. `node/ses` needs Node or Bun. `react` needs the `react`, `react-email` and `@react-email/render` peers. `pg` and `dot` need `@arki/journal`, `drizzle-orm` and `@arki/dot`.

Debug logs use the `arki:mail` category. Show them with `DEBUG=arki:mail`.

## Public imports

- `@arki/mail`: `mailer`, `defineTemplate`, `renderTemplate`, `failover`, `logTransport`, quota stores, the failures, `MailError`, `MAIL_ERROR_CODES` and the types.
- `@arki/mail/templates/auth`: `magicLink`, `verifyEmail`, `resetPassword`, `signInCode`.
- `@arki/mail/http/resend`, `/http/unosend`, `/http/cloudflare`, `/http/mailpit`: HTTP transports.
- `@arki/mail/node/ses`: the SES transport.
- `@arki/mail/react`: `renderReact`.
- `@arki/mail/pg`: `mailOutbox`. `@arki/mail/pg/testing`: `mailQueueAssertions`.
- `@arki/mail/dot`: `mail`, `mailOutboxPlugin`, `mailJobs`.
- `@arki/mail/testing`: `mailSink`, `transportContract`.

## Failure behaviour

A template validator that throws or rejects returns canonical `schema.validator_defect` (`ValidatorDefect` from `@arki/failure`). Rendering, composing, sending and enqueueing preserve this defect; it must not be retried as ordinary bad input.

`send` does not throw for a mail that was not sent. It returns a failure value, defined with `@arki/failure` and exported from `@arki/mail`. A mail that is not sent for a reason your code must expect is a returned failure, defined with `@arki/failure` and exported from `@arki/mail`. Check it with `isFailure`, a definition's `is`, or `match`. At an HTTP or oRPC boundary it answers with its status.

| Failure              | Code                   | Status | When                                                                              |
| -------------------- | ---------------------- | ------ | --------------------------------------------------------------------------------- |
| `MailInvalidInput`   | `mail.invalid_input`   | 422    | The template's schema refused the input. `data`: `template`, `issues`.            |
| `MailQuotaExhausted` | `mail.quota_exhausted` | 429    | Every transport is over quota. Nothing was sent. `data`: `month`.                 |
| `MailRejected`       | `mail.rejected`        | 422    | The service refused the mail. `data`: `transport`, `retryable`, `upstreamStatus`. |
| `MailUncertain`      | `mail.uncertain`       | 503    | No readable answer. The mail may have been sent. `data`: `transport`, `detail`.   |
| `MailExpired`        | `mail.expired`         | 410    | A queued mail passed its `expiresAt`. Nothing was sent. `data`: `expiresAt`.      |

A mistake in how the package is used is thrown as `MailError`, with a stable `code`:

| Code             | Name               | When                                                                   |
| ---------------- | ------------------ | ---------------------------------------------------------------------- |
| `ARKI_MAIL_E001` | `invalidConfig`    | No transport, two transports with one id, an empty sender, no SES SDK. |
| `ARKI_MAIL_E002` | `invalidMessage`   | No recipient, a line break in a header or address, a reserved header.  |
| `ARKI_MAIL_E005` | `unsupported`      | A field the transport cannot carry. Thrown before any request.         |
| `ARKI_MAIL_E009` | `needsTransaction` | `enqueue` got the root database.                                       |
| `ARKI_MAIL_E010` | `badQueuedData`    | A queued mail is too large, or a stored row cannot be read.            |

Handle the failures by what you know about delivery:

- `MailInvalidInput`, `MailQuotaExhausted`, `MailExpired`: nothing was sent. Fix the input, add a transport, or queue a new mail.
- `MailRejected`: the service surely did not take it. Retry later only when `data.retryable` is true.
- `MailUncertain`: the mail may have been delivered. See [Limits](#limits).

## Limits

- **Delivery is uncertain after a timeout.** When a request times out, the network drops, or the answer cannot be read, the service may already have the mail. `send` returns `MailUncertain`, not success and not a clean failure. `failover` does not try a second provider then, because it could deliver a duplicate. Retry with the same idempotency key, or accept the risk.
- Only a `MailRejected` proves the mail was not taken.
- Delivery through `@arki/mail/pg` is at least once. Resend drops a repeat within 24 hours. Other services may deliver a retry twice.
- Quota counts are advisory. Two replicas can both send the last mail of a quota.
- A queued mail has exactly one `to` recipient and at most 256 KiB (`maxBytes`).
- `text` is required on every template.

The boundary, in a test:

```ts run expect
import { z } from 'zod';

import { defineTemplate, mailer, MailUncertain } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

const sink = mailSink();
const mail = mailer({ transport: sink, from: 'hi@acme.dev' });
const ping = defineTemplate({ name: 'ping', input: z.object({}), subject: () => 'Ping', text: () => 'pong' });

sink.failNext(MailUncertain({ transport: 'sink', detail: 'request timed out' }));
const result = await mail.send(ping, {}, { to: 'ada@example.com' });

if (MailUncertain.is(result)) console.log('may have been delivered:', result.data.detail);
```

```text
may have been delivered: request timed out
```

## Templates

`defineTemplate({ name, input, subject, text, html?, defaults? })`. `input` is any Standard Schema: Zod, Valibot, ArkType or your own. Callers pass the schema's input type; renderers get its output, with defaults applied. Wrong data does not compile, and data the schema refuses comes back as `MailInvalidInput` with the schema's issues, before anything is sent.

`text` is required: every mail has a plain-text part. `html` is optional and may be async.

```ts
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { defineTemplate, renderTemplate } from '@arki/mail';

const receipt = defineTemplate({
  name: 'receipt',
  input: z.object({ total: z.string() }),
  subject: data => `Receipt: ${data.total}`,
  text: data => `You paid ${data.total}.`,
  html: data => `<p>You paid <b>${data.total}</b>.</p>`,
  defaults: { from: 'Billing <billing@acme.dev>' },
});

// No transport needed: previews and content tests.
const preview = await renderTemplate(receipt, { total: '5 EUR' });
if (!isFailure(preview)) console.info(preview.subject);
```

Sign-in mail is ready made in `@arki/mail/templates/auth`: `magicLink`, `verifyEmail`, `resetPassword` (`{ appName, url, expiresInMinutes? }`) and `signInCode` (`{ appName, code }`). They escape every value and refuse a URL that is not `http(s)`.

React Email works too. Render the element yourself, then send the result with `sendRaw`:

```tsx skip="needs a React Email component"
import { renderReact } from '@arki/mail/react';
import { MagicLinkEmail } from '@arki/mail/react/templates/magic-link';

const { html, text } = await renderReact(<MagicLinkEmail url={url} />);
await mail.sendRaw({ to, subject: 'Your sign-in link', html, text });
```

## Transports

A transport sends one mail through one service. It returns the sent mail or a failure, and each one maps the service's answer to the same failures, so `failover` and the journal treat every service alike.

| Transport        | Entry                        | Options                                           | Idempotency key | Notes                                                                 |
| ---------------- | ---------------------------- | ------------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `resend()`       | `@arki/mail/http/resend`     | `apiKey`                                          | yes             | Plain `fetch`, no SDK. Tags and several Reply-To addresses supported. |
| `unosend()`      | `@arki/mail/http/unosend`    | `apiKey`                                          | no              | Plain `fetch`. Tags throw `E005`.                                     |
| `cloudflare()`   | `@arki/mail/http/cloudflare` | `accountId`, `apiToken`                           | no              | Beta service. Reports each recipient; some bounced is `partial`.      |
| `ses()`          | `@arki/mail/node/ses`        | `region`, `credentials?`, `configurationSetName?` | no              | Needs the `@aws-sdk/client-sesv2` peer. SDK retries are off.          |
| `logTransport()` | `@arki/mail`                 | `id?`                                             | —               | Sends nothing.                                                        |

Every transport takes `id` (default: its name) and `quotaPerMonth`. HTTP transports also take `fetch` for tests.

How a service's answer maps:

| Answer                           | Result                                        | May the service have taken it? |
| -------------------------------- | --------------------------------------------- | ------------------------------ |
| 429 or 5xx                       | `MailRejected`, `data.retryable: true`        | no                             |
| any other 4xx                    | `MailRejected`, `data.retryable: false`       | no                             |
| network failure, timeout, abort  | `MailUncertain`                               | yes                            |
| 2xx that cannot be read          | `MailUncertain`, with `data.upstreamStatus`   | yes                            |
| a field the service cannot carry | throws `MailError` `E005`, before any request | no                             |

`MailRejected` carries the service's HTTP status as `data.upstreamStatus`, its own error code as `data.providerCode`, and what it said as `data.detail`.

A message id is the provider's, or `null` when it gives none. It is never made up.

## Failover and quotas

```ts
import type { KVLike } from '@arki/mail';
import { failover, kvQuotaStore, mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';
import { ses } from '@arki/mail/node/ses';

declare const kv: KVLike; // e.g. @arki/kv

const mail = mailer({
  transport: failover(
    [
      resend({ apiKey: process.env.RESEND_API_KEY ?? '', quotaPerMonth: 3000 }),
      ses({ region: 'eu-west-1' }), // no quota: the deliberate unlimited fallback
    ],
    { store: kvQuotaStore(kv) },
  ),
  from: 'Acme <hello@acme.dev>',
});
```

`failover` tries its transports in order:

- A transport over its quota for the UTC month is skipped. When every transport is over quota, nothing is sent (`E004`). A quota is a budget; add a transport without one if you want an unlimited fallback.
- After a failure it tries the next transport only when the provider surely did not take the mail (`MailRejected`) and a retry can help (`data.retryable`). After a timeout the first provider may already be delivering it, and a second provider would send a duplicate, so the failure is returned instead.
- A permanent refusal (a bad address) stops the chain.

A mailer with one transport that has a quota counts it the same way. `kvQuotaStore` shares counters between replicas; `inMemoryQuotaStore` (the default) counts in one process. Counts are advisory: two replicas can both send the last mail of a quota. A counter that cannot be read or written is logged and never stops or fails a send.

## Mail that commits with your write

`@arki/mail/pg` queues a mail as one row in the `@arki/journal` jobs table, inside your transaction. A rollback drops it with the write. The journal worker sends it, retries failures that can pass later, and dead-letters the rest.

```ts skip="needs a Postgres database and a journal"
import { mailOutbox } from '@arki/mail/pg';

const outbox = mailOutbox({ mailer: mail, tables });

await db.transaction(async tx => {
  const user = await createUser(tx, input);
  await outbox.enqueue(tx, welcome, { name: user.name }, { to: user.email, idempotencyKey: `welcome:${user.id}` });
});

// In the worker process:
await journal.worker(db, { jobs: outbox.runner });
```

- The row stores the rendered message, so every retry sends the same bytes.
- The job id is the idempotency key on every try. Resend drops a repeat within 24 hours; other services may deliver a retry twice. Delivery is at least once.
- The same `idempotencyKey` while a mail is still queued returns that job (`deduped: true`).
- `expiresAt` stops a stale mail: past it, the job is dead with `MailExpired` and nothing is sent. Use it for sign-in links.
- A queued mail has exactly one `to` recipient and no Cc or Bcc.
- `retry` sets the waits (default 5 s doubling to 1 h, 5 tries). Only `MailUncertain` and a `MailRejected` with `data.retryable` are tried again; any other failure is dead on its first try.
- `enqueue` returns `MailInvalidInput` for bad input, and queues nothing; your code decides whether the write still commits. It throws `MailError`: `E009` for the root database instead of a transaction, `E002` unless there is exactly one `to` recipient, `E010` when the message is over `maxBytes` (256 KiB).

## Dot

```ts skip="needs a Dot app with a journal"
import { mail, mailJobs, mailOutboxPlugin } from '@arki/mail/dot';

defineApp('shop')
  .use(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
  .use(mailOutboxPlugin({ tables }))
  .serve(journalWorker({ jobs: mailJobs() }));
```

- `mail(options)` provides `mail`. Pass a function so the manifest and `dot explain` never read your keys.
- `mailOutboxPlugin({ tables })` provides `mailOutbox` and needs `mail`. Without it the app does not compile.
- `mailJobs()` gives `journalWorker` the queued-mail runner.

## Testing

```ts
import { z } from 'zod';

import { defineTemplate, mailer, MailRejected } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

const sink = mailSink();
const mail = mailer({ transport: sink, from: 'hi@acme.dev' });
const ping = defineTemplate({ name: 'ping', input: z.object({}), subject: () => 'Ping', text: () => 'pong' });

await mail.send(ping, {}, { to: 'ada@example.com' });
console.info(sink.sentWith(ping).length, sink.sentTo('ada@example.com').length, sink.last()?.message.subject);

sink.failNext(MailRejected({ transport: 'sink', retryable: false })); // the next send fails once
```

- `mailSink()` records each message with its template name and idempotency key.
- `@arki/mail/pg/testing` has `mailQueueAssertions(db, tables)`: `queued(template?)` and `dead()` read committed rows, so a mail queued in a rolled-back transaction is not there.
- `transportContract(harness)` from `@arki/mail/testing` runs the shared transport tests against your own transport.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
