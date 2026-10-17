/**
 * Queued mail on the journal, on PGlite. Why these tests matter: a welcome mail for a sign-up
 * that rolled back is a lie to the customer, a stale magic link sent an hour late is a security
 * problem, and a mail retried forever (or never) is lost without anyone noticing.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Result } from '@arki/failure';
import type { JobRunner } from '@arki/journal';
import { orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';
import { backoff } from '@arki/resilience';

import type { MailMessage, MailTransport, SentMail, TransportFailure } from '../types.js';
import { MAIL_ERROR_CODES } from '../errors.js';
import { MailInvalidInput, MailQuotaExhausted, MailRejected, MailUncertain } from '../failures.js';
import { mailer } from '../mailer.js';
import { defineTemplate } from '../template.js';
import { mailOutbox } from './index.js';
import { mailQueueAssertions } from './testing.js';

const tables = journalTables();
const journal = initJournal({ tables }).compose({});

let db: PgliteDatabase;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(tables.jobs).where(sql`true`);
});

const magicLink = defineTemplate({
  name: 'auth.magic-link',
  input: z.object({ url: z.url() }),
  subject: () => 'Your sign-in link',
  text: data => `Sign in: ${data.url}`,
});

type Call = { readonly message: MailMessage; readonly idempotencyKey: string | undefined };

/** A transport that answers from a script (the last answer repeats) and records each call. */
function provider(...answers: ('ok' | TransportFailure)[]) {
  const calls: Call[] = [];
  const transport: MailTransport = {
    id: 'fake',
    send: (message, options) => {
      calls.push({ message, idempotencyKey: options.idempotencyKey });
      const answer = answers[Math.min(calls.length, answers.length) - 1] ?? 'ok';
      const result: Result<SentMail, TransportFailure> =
        answer === 'ok' ? { id: `m${calls.length}`, transport: 'fake', status: 'accepted', recipients: [] } : answer;
      return Promise.resolve(result);
    },
  };
  return { transport, calls };
}

const busy = (detail = 'busy') => MailRejected({ transport: 'fake', retryable: true, upstreamStatus: 503, detail });

/** Enqueues in a transaction and returns the job; the input is valid, so a failure is a test bug. */
async function enqueued(outbox: ReturnType<typeof outboxWith>, options: { readonly expiresAt?: Date } = {}) {
  const job = await db.transaction(tx =>
    outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to, ...options }),
  );
  if (MailInvalidInput.is(job)) throw new Error(job.message);
  return job;
}

/** Two retries after the first try, no wait. */
function outboxWith(transport: MailTransport, maxBytes?: number) {
  return mailOutbox({
    mailer: mailer({ transport, from: 'App <hi@app.dev>' }),
    tables,
    retry: backoff.constant(0).upTo(2),
    maxBytes,
  });
}

async function drainAll(runner: JobRunner): Promise<void> {
  while ((await journal.drain(db, { jobs: runner })) > 0);
}

const queue = () => mailQueueAssertions(db, tables);
const to = 'ada@example.com';

describe('the mail commits with the write', () => {
  it('a rolled-back transaction leaves no row, and nothing is sent', async () => {
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    await expect(
      db.transaction(async tx => {
        await orThrow(outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to }));
        throw new Error('sign-up failed');
      }),
    ).rejects.toThrow('sign-up failed');
    await drainAll(outbox.runner);
    expect(await queue().queued()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a committed mail is sent once by the worker and its row is gone', async () => {
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    await orThrow(db.transaction(tx => outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to })));
    expect(await queue().queued(magicLink)).toMatchObject([{ to, subject: 'Your sign-in link' }]);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
    expect(await queue().queued()).toEqual([]);
  });

  it('the root database is refused with E009: the guarantee cannot be skipped', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const refused = outbox.enqueue(
      // @ts-expect-error -- the root database has no `rollback`, so it is not a MailTx
      db,
      magicLink,
      { url: 'https://app.dev/l/1' },
      { to },
    );
    await expect(refused).rejects.toMatchObject({ code: MAIL_ERROR_CODES.needsTransaction });
  });
});

describe('retries belong to the journal', () => {
  it('a retryable failure is tried again, then dead-lettered with the last error', async () => {
    const { transport, calls } = provider(busy('provider busy'));
    const outbox = outboxWith(transport);
    await enqueued(outbox);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(3);
    const [dead] = await queue().dead();
    expect(dead?.attempts).toBe(3);
    expect(dead?.lastError).toContain('provider busy');
    expect(dead?.lastError).toContain('mail.rejected');
  });

  it('an uncertain send is tried again: the job id keeps a provider from delivering it twice', async () => {
    const { transport, calls } = provider(MailUncertain({ transport: 'fake', detail: 'timed out' }), 'ok');
    const outbox = outboxWith(transport);
    await enqueued(outbox);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(2);
    expect(await queue().dead()).toEqual([]);
  });

  it('a refusal no retry can fix is dead on the first try', async () => {
    const detail = 'mailbox does not exist';
    const { transport, calls } = provider(MailRejected({ transport: 'fake', retryable: false, detail }));
    const outbox = outboxWith(transport);
    await enqueued(outbox);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
    expect(await queue().dead()).toHaveLength(1);
  });

  it('an exhausted quota is dead on the first try: a quota is a budget, and retries would spend it', async () => {
    const { transport, calls } = provider(MailQuotaExhausted({ month: '2026-10' }));
    const outbox = outboxWith(transport);
    await enqueued(outbox);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
    expect(await queue().dead()).toHaveLength(1);
  });

  it('every retry sends the same message with the job id as the idempotency key', async () => {
    const { transport, calls } = provider(busy(), 'ok');
    const outbox = outboxWith(transport);
    const { jobId } = await enqueued(outbox);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.message).toEqual(calls[0]?.message);
    expect(calls.map(call => call.idempotencyKey)).toEqual([jobId, jobId]);
  });
});

describe('what is accepted into the queue', () => {
  it('the same idempotency key while a mail is queued returns that job: a double submit sends one mail', async () => {
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    const enqueue = () =>
      db.transaction(tx =>
        outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to, idempotencyKey: 'signin-42' }),
      );
    const first = await enqueue();
    const second = await enqueue();
    if (MailInvalidInput.is(first)) throw new Error(first.message);
    expect(second).toEqual({ jobId: first.jobId, deduped: true });
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
  });

  it('bad input is returned as MailInvalidInput and nothing is queued; the caller decides about its write', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      // @ts-expect-error -- not a URL; refused at compile time and at run time
      outbox.enqueue(tx, magicLink, { url: 42 }, { to }),
    );
    expect(MailInvalidInput.is(result)).toBe(true);
    expect(await queue().queued()).toEqual([]);
  });

  it('an oversized mail throws E010 before the insert', async () => {
    const outbox = outboxWith(provider('ok').transport, 200);
    const write = db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: `https://app.dev/${'x'.repeat(300)}` }, { to }),
    );
    await expect(write).rejects.toMatchObject({ code: MAIL_ERROR_CODES.badQueuedData });
  });

  it('a queued mail has exactly one recipient: per-recipient results need their own jobs', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const write = db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to: [to, 'bob@example.com'] }),
    );
    await expect(write).rejects.toMatchObject({ code: MAIL_ERROR_CODES.invalidMessage });
  });
});

describe('expiry', () => {
  it('a mail past its expiresAt is not sent: it is dead on the first try with MailExpired', async () => {
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    await enqueued(outbox, { expiresAt: new Date(Date.now() - 1000) });
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(0);
    const [dead] = await queue().dead();
    expect(dead?.attempts).toBe(1);
    expect(dead?.lastError).toContain('mail.expired');
  });
});
