# @arki/mail for agents

Read this before changing code that sends mail. The [README](../README.md) is the long overview.

## The model

- A **template** (`defineTemplate`) is a plain object: a `name`, an `input` Standard Schema, and `subject`, `text` and optional `html` renderers. Callers pass the schema's input; renderers get its output.
- A **transport** sends one mail through one service. It returns the sent mail or a failure value from `@arki/failure`: `MailRejected` (the service refused it, so it surely did not take it; `data.retryable` is true for 429 and 5xx) or `MailUncertain` (no readable answer, so it may have taken it). It throws only `MailError` `E005`, for a field it cannot carry.
- **`failover([...])`** is a transport made of transports. It skips one over its monthly quota and moves on only after a definite, retryable refusal.
- A **mailer** (`mailer({ transport, from })`) renders, checks the message (no header injection, a recipient present), sends, and reports events. It returns the `SentMail` itself, or a failure; check with `isFailure` or a definition's `is`.
- **`mailOutbox`** (`@arki/mail/pg`) stores a rendered mail as one `@arki/journal` queue row inside the caller's transaction. The journal worker sends, retries and dead-letters it.

## Task map

### Send a templated mail

```ts
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { defineTemplate, logTransport, mailer } from '@arki/mail';

const invite = defineTemplate({
  name: 'team.invite',
  input: z.object({ team: z.string(), url: z.url() }),
  subject: data => `Join ${data.team}`,
  text: data => `You are invited to ${data.team}: ${data.url}`,
});

const mail = mailer({ transport: logTransport(), from: 'Analytical Pizza <hello@pizza.example>' });
const result = await mail.send(invite, { team: 'Core', url: 'https://pizza.example/i/1' }, { to: 'ada@example.com' });
if (isFailure(result)) throw new Error(result.message);
```

### Use several providers

```ts
import { failover, mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';
import { unosend } from '@arki/mail/http/unosend';

const mail = mailer({
  transport: failover([
    resend({ apiKey: process.env.RESEND_API_KEY ?? '', quotaPerMonth: 3000 }),
    unosend({ apiKey: process.env.UNOSEND_API_KEY ?? '' }),
  ]),
  from: 'Analytical Pizza <hello@pizza.example>',
});
```

Pass `{ store: kvQuotaStore(kv) }` as the second argument when several replicas send.

### Queue a mail with a write

```ts skip="needs a Postgres database and a journal"
const outbox = mailOutbox({ mailer: mail, tables });
await db.transaction(tx => outbox.enqueue(tx, invite, input, { to, expiresAt }));
await journal.worker(db, { jobs: outbox.runner });
```

The row holds the rendered message. Each retry passes the job id as the idempotency key.

### Wire mail into a Dot app

```ts skip="needs a Dot app with a journal"
defineApp('shop')
  .infra(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
  .infra(mailOutboxPlugin({ tables }))
  .entrypoints(journalWorker({ jobs: mailJobs() }));
```

### Test code that sends mail

```ts
import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

const sink = mailSink();
const mail = mailer({ transport: sink, from: 'hello@pizza.example' });
await mail.sendRaw({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' });
if (sink.sentTo('ada@example.com').length !== 1) throw new Error('expected one mail');
```

For queued mail, assert on committed rows with `mailQueueAssertions(db, tables)` from `@arki/mail/pg/testing`.

## Rules that bite

- `send`, `sendRaw`, `compose` and `render` return failures; they do not throw them. Misuse throws `MailError`: bad configuration (`E001`), a message that cannot be sent as written (`E002`), a field the transport cannot carry (`E005`).
- Retry only `MailUncertain`, or `MailRejected` with `data.retryable`. After `MailUncertain` never send through a second provider: the first may already be delivering it.
- `text` is required on every template and every raw mail.
- All transports over quota means nothing is sent (`MailQuotaExhausted`). There is no silent overrun.
- Never wrap a transport in your own retry loop. Queue the mail; the journal is the only retrier.
- A queued mail has one `to` recipient and no Cc or Bcc. Queue one job per recipient.
- Set `expiresAt` on queued sign-in links, so a late retry does not send a stale link.
- `SentMail.id` is `null` when the service returns no id.

## Errors

### Failures (returned)

| Definition           | Code                   | Status | Meaning                                                    | Retryable                 |
| -------------------- | ---------------------- | ------ | ---------------------------------------------------------- | ------------------------- |
| `MailInvalidInput`   | `mail.invalid_input`   | 422    | The template's schema refused the input. Carries `issues`. | no                        |
| `MailQuotaExhausted` | `mail.quota_exhausted` | 429    | Every transport is over quota. Nothing sent.               | no                        |
| `MailRejected`       | `mail.rejected`        | 422    | The service refused the mail.                              | when `data.retryable`     |
| `MailUncertain`      | `mail.uncertain`       | 503    | No readable answer. The mail may have been sent.           | yes, never on another one |
| `MailExpired`        | `mail.expired`         | 410    | A queued mail expired before it was sent.                  | no                        |

### Errors (thrown)

| Code             | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `ARKI_MAIL_E001` | Bad configuration, or a transport SDK that cannot load. |
| `ARKI_MAIL_E002` | Bad message: no recipient, line break, reserved header. |
| `ARKI_MAIL_E005` | The transport cannot carry a field. Nothing sent.       |
| `ARKI_MAIL_E009` | `enqueue` got the root database.                        |
| `ARKI_MAIL_E010` | Queued mail too large, or a stored row unreadable.      |

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/mail
cd packages/mail && bun run test:docs
cd packages/mail && bun run test:runtimes
dot explain --json | jq .data.services   # in an app using @arki/mail/dot: lists mail and mailOutbox
dot doctor --json | jq .data             # in that app: no missing mail service
```

Queued mail also returns the journal's exact canonical ID generation failures when secure entropy is unavailable or fails; no job is inserted.

Template validator exceptions return canonical `ValidatorDefect` from `@arki/failure` through render, compose, send and enqueue; handle it as a fatal defect, not invalid user input.
