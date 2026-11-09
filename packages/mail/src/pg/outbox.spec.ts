/**
 * Queued mail on the journal, on PGlite. Why these tests matter: a welcome mail for a sign-up
 * that rolled back is a lie to the customer, a stale magic link sent an hour late is a security
 * problem, and a mail retried forever (or never) is lost without anyone noticing.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  MailEnqueueContended,
  MailInvalidInput,
  MailInvalidMessage,
  MailQuotaExhausted,
  MailRejected,
  MailTooLarge,
  MailUncertain,
} from '../failures.js';
import { mailer } from '../mailer.js';
import { defineTemplate } from '../template.js';
import { MAIL_JOB } from './args.js';
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
  return orThrow(job);
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
  while (orThrow(await journal.drain(db, { jobs: runner })) > 0);
}

const queue = () => mailQueueAssertions(db, tables);
const to = 'ada@example.com';

describe('the mail commits with the write', () => {
  it('returns unavailable entropy without queuing or sending mail', async () => {
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    vi.stubGlobal('crypto', null);
    let result: unknown;
    try {
      result = await db.transaction(tx => outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result).toMatchObject({ code: 'contracts.random_source_unavailable', status: 500 });
    expect(await queue().queued()).toEqual([]);
    expect(calls).toEqual([]);
  });
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
    const first = await orThrow(enqueue());
    const second = await enqueue();
    expect(second).toEqual({ jobId: first.jobId, deduped: true });
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
  });

  it('a dedupe race that frees the key between the refused insert and the select queues the mail instead of throwing', async () => {
    // WHY: the worker may send and delete the queued job in that gap. That is a normal concurrent case, not a caller bug; the key is free, so the mail is queued.
    const { transport, calls } = provider('ok');
    const outbox = outboxWith(transport);
    const result = await db.transaction(tx => {
      const realInsert = tx.insert.bind(tx);
      let refused = false;
      // The first insert answers like the dedupe index refused it (no row), and no job holds the key: the state after the worker deleted the winner.
      const racing = Object.create(tx, {
        insert: {
          value: (table: Parameters<typeof tx.insert>[0]) => {
            if (refused) return realInsert(table);
            refused = true;
            return { values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) }) };
          },
        },
      });
      return outbox.enqueue(racing, magicLink, { url: 'https://app.dev/l/1' }, { to, idempotencyKey: 'raced-1' });
    });
    const queued = await orThrow(Promise.resolve(result));
    expect(queued.deduped).toBe(false);
    await drainAll(outbox.runner);
    expect(calls).toHaveLength(1);
  });

  it('a key that keeps changing hands returns MailEnqueueContended after three tries and queues nothing', async () => {
    // WHY: constant contention on one idempotency key is an outside condition, not a caller bug; the caller gets a typed, retryable failure instead of a plain Error that loses its transaction.
    const outbox = outboxWith(provider('ok').transport);
    let attempts = 0;
    const result = await db.transaction(tx => {
      // Every insert answers like the dedupe index refused it, and the real select finds no job holding the key: another writer won it and its job was sent each time.
      const racing = Object.create(tx, {
        insert: {
          value: () => {
            attempts += 1;
            return { values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) }) };
          },
        },
      });
      return outbox.enqueue(racing, magicLink, { url: 'https://app.dev/l/2' }, { to, idempotencyKey: 'contended-1' });
    });
    expect(MailEnqueueContended.is(result)).toBe(true);
    expect(MailEnqueueContended.is(result) && result.data.attempts).toBe(3);
    expect(attempts).toBe(3);
    expect(await queue().queued()).toEqual([]);
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

  it('an oversized mail is a returned MailTooLarge before the insert', async () => {
    const outbox = outboxWith(provider('ok').transport, 200);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: `https://app.dev/${'x'.repeat(300)}` }, { to }),
    );
    expect(MailTooLarge.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { maxBytes: 200 } });
    expect(await queue().queued()).toEqual([]);
  });

  // Why: `bytes > NaN` is never true, so a NaN limit let every mail through; a limit of 0 or less refused every mail.
  it.each([Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'a maxBytes of %s throws E001 when the outbox is built',
    maxBytes => {
      expect(() => outboxWith(provider('ok').transport, maxBytes)).toThrow(
        expect.objectContaining({ name: 'MailError', code: MAIL_ERROR_CODES.invalidConfig }),
      );
    },
  );

  it('a recipient that cannot be mailed is a returned MailInvalidMessage and queues nothing', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to: ' ' }),
    );
    expect(MailInvalidMessage.is(result)).toBe(true);
    expect(await queue().queued()).toEqual([]);
  });

  // Template input and keys often come from users or request headers: a value Postgres would refuse
  // must come back as a failure the caller can show, never a raw driver error that fails the write.
  it('a NUL character in the rendered mail is a returned MailInvalidMessage, not a Postgres error', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/\u0000' }, { to }),
    );
    expect(result).toMatchObject({ code: 'mail.invalid_message', status: 422 });
    expect(await queue().queued()).toEqual([]);
  });

  // Postgres refuses a lone surrogate's \ud800 escape in the jsonb args column with SQLSTATE 22P02 (audit-4 #7).
  it('a lone surrogate in the template input is a returned MailInvalidMessage, not a Postgres error', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/\uD800' }, { to }),
    );
    expect(result).toMatchObject({ code: 'mail.invalid_message', status: 422 });
    expect(await queue().queued()).toEqual([]);
  });

  // toISOString throws a RangeError on an Invalid Date (audit-4 #7); the caller gets a failure to show instead.
  it('an expiresAt that is an Invalid Date is a returned MailInvalidMessage and queues nothing', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to, expiresAt: new Date(Number.NaN) }),
    );
    expect(result).toMatchObject({ code: 'mail.invalid_message', status: 422 });
    expect(await queue().queued()).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['holding a NUL character', 'order\u00001'],
    // The driver writes a lone surrogate as U+FFFD, so 'k\uD800' and 'k\uDC00' would share one dedupe slot.
    ['holding a lone surrogate', 'order\uD800'],
    ['over 256 characters', 'k'.repeat(257)],
  ])('an idempotencyKey %s is a returned MailInvalidMessage and queues nothing', async (_case, idempotencyKey) => {
    const outbox = outboxWith(provider('ok').transport);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to, idempotencyKey }),
    );
    expect(result).toMatchObject({ code: 'mail.invalid_message', status: 422 });
    expect(await queue().queued()).toEqual([]);
  });

  it('an idempotencyKey of exactly 256 characters, counted in code points, is queued', async () => {
    const outbox = outboxWith(provider('ok').transport);
    const idempotencyKey = '\u{1F600}'.repeat(256);
    const result = await db.transaction(tx =>
      outbox.enqueue(tx, magicLink, { url: 'https://app.dev/l/1' }, { to, idempotencyKey }),
    );
    expect(orThrow(result).deduped).toBe(false);
  });

  // The service said how long to wait; asking again sooner only burns a try.
  it('waits at least as long as the service asked in Retry-After before the next try', async () => {
    const asked = MailRejected({ transport: 'fake', retryable: true, upstreamStatus: 429, retryAfterMs: 90_000 });
    const outbox = outboxWith(provider(asked).transport);
    const job = await enqueued(outbox);
    const stored = await db.select().from(tables.jobs);
    const row = stored.find(candidate => candidate.id === job.jobId);
    if (row === undefined) throw new Error('the queued job is missing');
    const scheduled = { id: row.id, name: MAIL_JOB, args: row.args, attempt: 1 };
    const thrown = await outbox.runner
      .run(scheduled, { db, signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(outbox.runner.retryDelay(scheduled, thrown)).toBeGreaterThanOrEqual(90_000);
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
