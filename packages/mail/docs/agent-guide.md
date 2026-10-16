# @arki/mail for agents

Read this before changing code that sends mail. The [README](../README.md) is the long overview.

## The model

- A **template** (`defineTemplate`) is a plain object: a `name`, an `input` Standard Schema, and `subject`, `text` and optional `html` renderers. Callers pass the schema's input; renderers get its output.
- A **transport** sends one mail through one service and never throws. Every failure is a `MailFailure` with a `code`, `retryable` and `acceptance` (`none`: the service did not take it; `unknown`: it may have).
- **`failover([...])`** is a transport made of transports. It skips one over its monthly quota and moves on only after a definite, retryable refusal.
- A **mailer** (`mailer({ transport, from })`) renders, checks the message (no header injection, a recipient present), sends, and reports events. It returns `{ data, error }`.
- **`mailOutbox`** (`@arki/mail/pg`) stores a rendered mail as one `@arki/journal` queue row inside the caller's transaction. The journal worker sends, retries and dead-letters it.

## Task map

### Send a templated mail

```ts
import { z } from 'zod';

import { defineTemplate, logTransport, mailer } from '@arki/mail';

const invite = defineTemplate({
  name: 'team.invite',
  input: z.object({ team: z.string(), url: z.url() }),
  subject: data => `Join ${data.team}`,
  text: data => `You are invited to ${data.team}: ${data.url}`,
});

const mail = mailer({ transport: logTransport(), from: 'Acme <hi@acme.dev>' });
const result = await mail.send(invite, { team: 'Core', url: 'https://acme.dev/i/1' }, { to: 'ada@example.com' });
if (result.error !== null) throw new Error(result.error.message);
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
  from: 'Acme <hi@acme.dev>',
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
  .use(mail(() => ({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'Shop <hi@shop.dev>' })))
  .use(mailOutboxPlugin({ tables }))
  .serve(journalWorker({ jobs: mailJobs() }));
```

### Test code that sends mail

```ts
import { mailer } from '@arki/mail';
import { mailSink } from '@arki/mail/testing';

const sink = mailSink();
const mail = mailer({ transport: sink, from: 'hi@acme.dev' });
await mail.sendRaw({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' });
if (sink.sentTo('ada@example.com').length !== 1) throw new Error('expected one mail');
```

For queued mail, assert on committed rows with `mailQueueAssertions(db, tables)` from `@arki/mail/pg/testing`.

## Rules that bite

- `send` and `sendRaw` return failures; they do not throw them. Only configuration mistakes (`E001`) and `mailOutbox.enqueue` throw `MailError`.
- `text` is required on every template and every raw mail.
- All transports over quota means nothing is sent (`E004`). There is no silent overrun.
- Never wrap a transport in your own retry loop. Queue the mail; the journal is the only retrier.
- A queued mail has one `to` recipient and no Cc or Bcc. Queue one job per recipient.
- Set `expiresAt` on queued sign-in links, so a late retry does not send a stale link.
- `SentMail.id` is `null` when the service returns no id.

## Errors

| Code             | Meaning                                                 | Retryable        |
| ---------------- | ------------------------------------------------------- | ---------------- |
| `ARKI_MAIL_E001` | Bad configuration. Thrown.                              | no               |
| `ARKI_MAIL_E002` | Bad message: no recipient, line break, reserved header. | no               |
| `ARKI_MAIL_E003` | The template's schema refused the input.                | no               |
| `ARKI_MAIL_E004` | Every transport is over quota. Nothing sent.            | no               |
| `ARKI_MAIL_E005` | The transport cannot carry a field. Nothing sent.       | no               |
| `ARKI_MAIL_E006` | The service refused the mail.                           | 429 and 5xx only |
| `ARKI_MAIL_E007` | No answer. The mail may have been sent.                 | yes              |
| `ARKI_MAIL_E008` | The answer could not be read.                           | yes              |
| `ARKI_MAIL_E009` | `enqueue` got the root database. Thrown.                | no               |
| `ARKI_MAIL_E010` | Queued mail too large, or a stored row unreadable.      | no               |
| `ARKI_MAIL_E011` | A queued mail expired before it was sent.               | no               |

## Verify

```sh
turbo run build typecheck lint test --filter=@arki/mail
cd packages/mail && bun run test:docs
cd packages/mail && bun run test:runtimes
dot explain --json | jq .data.services   # in an app using @arki/mail/dot: lists mail and mailOutbox
dot doctor --json | jq .data             # in that app: no missing mail service
```
