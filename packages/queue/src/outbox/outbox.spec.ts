/**
 * The outbox on PGlite: scheduling in the caller's transaction, and the journal worker running
 * the rows through `outboxRunner`. PGlite has one connection, so locking is proven elsewhere
 * (`@arki/journal`'s Postgres suite); here we prove atomicity, validation and the runner.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ScheduledJob } from '@arki/journal';
import { z } from '@arki/contracts';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';
import { backoff } from '@arki/resilience';

import type { JobContext } from '../types/job.ts';
import { initQueue } from '../init.ts';
import { QUEUE_PRIORITIES } from '../types/job.ts';
import { isOutboxError, OUTBOX_ERROR_CODES, outboxError } from './errors.ts';
import { assertJsonArgs, outbox } from './outbox.ts';
import { jobsByName } from './registry.ts';
import { outboxRunner } from './runner.ts';

const tables = journalTables();
const journal = initJournal({ meta: z.object({}) }).compose({ tables });
const schedule = outbox({ tables });

type Ctx = { readonly tag: string };
const q = initQueue.context<Ctx>().create();

const handled: { readonly name: string; readonly data: unknown; readonly jobId: string | undefined }[] = [];
const order: string[] = [];
let failures = 0;

const outer = q.middleware<JobContext<Ctx>, JobContext<Ctx>>(async opts => {
  order.push('outer:before');
  const result = await opts.next({ ctx: opts.ctx });
  order.push('outer:after');
  return result;
});
const inner = q.middleware<JobContext<Ctx>, JobContext<Ctx>>(async opts => {
  order.push(`inner:${opts.ctx.tag}`);
  return opts.next({ ctx: opts.ctx });
});

const welcome = q.job
  .name('mail.welcome.v1')
  .input(z.object({ userId: z.string().min(1) }))
  .handler(async (data, ctx) => {
    handled.push({ name: 'mail.welcome.v1', data, jobId: ctx.job.id });
    return { sent: true };
  });

const wrapped = q.job
  .use(outer)
  .use(inner)
  .name('wrapped')
  .input(z.object({ n: z.number() }))
  .options({ retry: backoff.constant(0).upTo(1) })
  .handler(async (data, ctx) => {
    order.push('handler');
    handled.push({ name: 'wrapped', data, jobId: ctx.job.id });
    if (failures > 0) {
      failures -= 1;
      throw new Error('flaky');
    }
  });

const shout = q.job
  .name('shout')
  .input(z.string().transform(text => `${text}!`))
  .handler(async (data, ctx) => {
    handled.push({ name: 'shout', data, jobId: ctx.job.id });
  });

const anything = q.job
  .name('anything')
  .input(z.unknown())
  .handler(() => Promise.resolve({}));

const dated = q.job
  .name('dated')
  .input(z.object({ when: z.date() }))
  .handler(() => Promise.resolve({}));

const registry = q.registry({ mail: { welcome }, wrapped, shout, anything, dated });
let contextBuilds = 0;
const runner = outboxRunner({
  registry,
  context: () => {
    contextBuilds += 1;
    return { tag: 'ctx' };
  },
});

let db: PgliteDatabase;
let client: PGlite;
const notifies: string[] = [];

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables }));
  await client.listen(journal.wakeChannel, payload => notifies.push(payload));
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(tables.jobs).where(sql`true`);
  handled.length = 0;
  order.length = 0;
  notifies.length = 0;
  failures = 0;
});

const rows = () => db.select().from(tables.jobs);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('runAfter in a transaction', () => {
  it('a committed transaction leaves one row and one wake; a rolled-back one leaves neither', async () => {
    // Why: the row must commit with the business write or not at all; that is the whole lesson.
    await expect(
      db.transaction(async tx => {
        await schedule.runAfter(tx, welcome, { userId: 'u1' });
        tx.rollback();
      }),
    ).rejects.toThrow();
    await settle();
    expect(await rows()).toEqual([]);
    expect(notifies).toEqual([]);

    const scheduled = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'u1' }));
    await settle();
    expect(scheduled.deduplicated).toBe(false);
    expect(scheduled.id).toMatch(/^job_/);
    expect(await rows()).toMatchObject([
      { id: scheduled.id, kind: 'queue', jobName: 'mail.welcome.v1', args: { userId: 'u1' }, priority: 0 },
    ]);
    expect(notifies).toEqual(['{"queue":1}']);
  });

  it('a savepoint rollback removes only the row scheduled inside it', async () => {
    await db.transaction(async tx => {
      await schedule.runAfter(tx, welcome, { userId: 'kept' });
      await tx
        .transaction(async savepoint => {
          await schedule.runAfter(savepoint, welcome, { userId: 'dropped' });
          savepoint.rollback();
        })
        .catch(() => 'rolled back');
    });
    const kept = await rows();
    expect(kept.map(row => row.args)).toEqual([{ userId: 'kept' }]);
  });

  it('refuses a root database at run time, before any SQL', async () => {
    // @ts-expect-error -- a root database is not an OutboxTx: it has no rollback()
    const call = schedule.runAfter(db, welcome, { userId: 'u1' });
    await expect(call).rejects.toMatchObject({ code: OUTBOX_ERROR_CODES.notInTransaction });
    expect(await rows()).toEqual([]);
  });

  it('two calls without a key are two rows; the same key is one row, in one transaction or across two', async () => {
    await db.transaction(async tx => {
      await schedule.runAfter(tx, welcome, { userId: 'a' });
      await schedule.runAfter(tx, welcome, { userId: 'a' });
    });
    expect(await rows()).toHaveLength(2);
    await db.delete(tables.jobs).where(sql`true`);

    const [first, again] = await db.transaction(async tx => [
      await schedule.runAfter(tx, welcome, { userId: 'a' }, { key: 'welcome:a' }),
      await schedule.runAfter(tx, welcome, { userId: 'a' }, { key: 'welcome:a' }),
    ]);
    const later = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'a' }, { key: 'welcome:a' }));
    expect(first).toEqual({ id: first?.id, deduplicated: false });
    expect(again).toEqual({ id: first?.id, deduplicated: true });
    expect(later).toEqual({ id: first?.id, deduplicated: true });
    expect(await rows()).toHaveLength(1);
    // The key is scoped per job name.
    await db.transaction(tx => schedule.runAfter(tx, wrapped, { n: 1 }, { key: 'welcome:a' }));
    expect(await rows()).toHaveLength(2);
  });

  it('bad args throw before any SQL, with the schema issues as the cause', async () => {
    const error: unknown = await db
      .transaction(tx =>
        // @ts-expect-error -- userId must be a string
        schedule.runAfter(tx, welcome, { userId: 1 }),
      )
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: OUTBOX_ERROR_CODES.badArgs });
    expect(isOutboxError(error) && error.cause).toBeInstanceOf(Error);
    expect(await rows()).toEqual([]);
  });

  it('refuses args that are not plain JSON, and measures the cap in UTF-8 bytes, not characters', async () => {
    await expect(
      db.transaction(tx => schedule.runAfter(tx, dated, { when: new Date() })),
    ).rejects.toMatchObject({ code: OUTBOX_ERROR_CODES.notJson });
    // 160 000 two-byte characters: under the cap in characters, over it in bytes.
    await expect(
      db.transaction(tx => schedule.runAfter(tx, anything, 'é'.repeat(160_000))),
    ).rejects.toMatchObject({ code: OUTBOX_ERROR_CODES.notJson });
    expect(await rows()).toEqual([]);
  });

  it('stores JSON null as a value', async () => {
    await db.transaction(tx => schedule.runAfter(tx, anything, null));
    expect(await rows()).toMatchObject([{ args: null }]);
  });

  it('delayMs counts from the transaction’s now(); runAt in the past is due now; a bad time throws', async () => {
    const [{ txNow }, scheduled] = await db.transaction(async tx => {
      const result = await tx.execute<{ txNow: string }>(sql`select now()::text as "txNow"`);
      const now = result.rows[0];
      if (now === undefined) throw new Error('no now()');
      return [now, await schedule.runAfter(tx, welcome, { userId: 'later' }, { delayMs: 60_000 })] as const;
    });
    const [row] = await db.select().from(tables.jobs).where(eq(tables.jobs.id, scheduled.id));
    expect(row?.availableAt.getTime()).toBe(new Date(txNow).getTime() + 60_000);

    const past = await db.transaction(tx => schedule.runAt(tx, welcome, { userId: 'past' }, new Date(0)));
    expect(await journal.drain(db, { jobs: runner })).toBe(1);
    expect(handled.map(job => job.jobId)).toEqual([past.id]);

    await expect(
      db.transaction(tx => schedule.runAt(tx, welcome, { userId: 'x' }, new Date('nope'))),
    ).rejects.toMatchObject({ code: OUTBOX_ERROR_CODES.badTiming });
    await expect(
      db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'x' }, { delayMs: -1 })),
    ).rejects.toMatchObject({ code: OUTBOX_ERROR_CODES.badTiming });
  });

  it('maps queue priorities onto the journal scale: NORMAL ties with effects, CRITICAL runs first', async () => {
    const stored: Record<string, number> = {};
    for (const [label, priority] of Object.entries(QUEUE_PRIORITIES)) {
      const { id } = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: label }, { priority }));
      const [row] = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
      stored[label] = row?.priority ?? Number.NaN;
    }
    expect(stored).toEqual({ CRITICAL: 4, HIGH: 2, NORMAL: 0, LOW: -2, BACKGROUND: -5 });
    await journal.drain(db, { jobs: runner });
    expect(handled.map(job => job.data)).toEqual(
      ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'].map(userId => ({ userId })),
    );
  });

  it('cancel deletes a pending row so it never runs; a leased row is not cancelled and finishes', async () => {
    const pending = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'p' }));
    expect(await db.transaction(tx => schedule.cancel(tx, pending.id))).toBe(true);
    const leased = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'l' }));
    await db.update(tables.jobs).set({ leaseToken: 'worker-a' }).where(eq(tables.jobs.id, leased.id));
    expect(await db.transaction(tx => schedule.cancel(tx, leased.id))).toBe(false);
    expect(await db.transaction(tx => schedule.cancel(tx, 'job_missing'))).toBe(false);
    const left = await rows();
    expect(left.map(row => row.id)).toEqual([leased.id]);
  });
});

describe('outboxRunner on the journal worker', () => {
  it('schedule → worker → the handler ran once, with the row id as ctx.job.id', async () => {
    const worker = journal.worker(db, {
      pollMs: 60_000,
      jobs: runner,
      listen: onMessage => client.listen(journal.wakeChannel, onMessage),
    });
    await worker.start();
    const { id } = await db.transaction(tx => schedule.runAfter(tx, welcome, { userId: 'u9' }));
    for (let i = 0; i < 100 && handled.length === 0; i++) await settle();
    await worker.stop();
    // With a 60 s poll, only the commit's NOTIFY can have woken the worker this fast.
    expect(handled).toEqual([{ name: 'mail.welcome.v1', data: { userId: 'u9' }, jobId: id }]);
    expect(await rows()).toEqual([]);
  });

  it('runs the middleware chain in the same order and context as BullMQ, and retries with the job’s own backoff', async () => {
    failures = 1;
    await db.transaction(tx => schedule.runAfter(tx, wrapped, { n: 7 }));
    expect(await journal.drain(db, { jobs: runner })).toBe(2);
    // The first try throws through the chain, so the outer middleware's `after` runs only on the second.
    expect(order).toEqual([
      'outer:before',
      'inner:ctx',
      'handler',
      'outer:before',
      'inner:ctx',
      'handler',
      'outer:after',
    ]);
    expect(await rows()).toEqual([]);
    expect(contextBuilds).toBe(1);
  });

  it('a job that keeps failing goes dead after its backoff; journal.retry runs it again under the same id', async () => {
    failures = 5;
    const { id } = await db.transaction(tx => schedule.runAfter(tx, wrapped, { n: 1 }));
    await journal.drain(db, { jobs: runner });
    const [dead] = await rows();
    expect(dead).toMatchObject({ id, attempts: 2 });
    expect(dead?.deadAt).toBeInstanceOf(Date);
    failures = 0;
    await journal.retry(db, id);
    await journal.drain(db, { jobs: runner });
    expect(handled.map(job => job.jobId)).toEqual([id, id, id]);
    expect(await rows()).toEqual([]);
  });

  it('runs a transform once, at the worker: the row keeps the raw input', async () => {
    await db.transaction(tx => schedule.runAfter(tx, shout, 'hi'));
    expect(await rows()).toMatchObject([{ args: 'hi' }]);
    await journal.drain(db, { jobs: runner });
    expect(handled).toMatchObject([{ name: 'shout', data: 'hi!' }]);
  });

  it('stored args that fail the schema go dead at once, without calling the handler', async () => {
    await db.insert(tables.jobs).values({ id: 'job_bad', kind: 'queue', jobName: 'mail.welcome.v1', args: { nope: 1 } });
    expect(await journal.drain(db, { jobs: runner })).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ attempts: 1 });
    expect(row?.deadAt).toBeInstanceOf(Date);
    expect(row?.lastError).toContain('fail the job');
    expect(handled).toEqual([]);
  });
});

describe('pieces', () => {
  const job = (name: string, attempt: number): ScheduledJob => ({ id: 'job_1', name, args: {}, attempt });

  it('retryDelay: the job’s backoff, the default of 3 tries, and dead for bad stored args', () => {
    expect(runner.retryDelay(job('wrapped', 1), new Error('x'))).toBe(0);
    expect(runner.retryDelay(job('wrapped', 2), new Error('x'))).toBeUndefined();
    expect(runner.retryDelay(job('mail.welcome.v1', 2), new Error('x'))).toBeTypeOf('number');
    expect(runner.retryDelay(job('mail.welcome.v1', 3), new Error('x'))).toBeUndefined();
    const bad = outboxError(OUTBOX_ERROR_CODES.badStoredArgs, 'bad');
    expect(runner.retryDelay(job('mail.welcome.v1', 1), bad)).toBeUndefined();
  });

  it('flattens a nested registry by persisted name and refuses two jobs with one name', () => {
    expect([...jobsByName(registry).keys()].toSorted()).toEqual(['anything', 'dated', 'mail.welcome.v1', 'shout', 'wrapped']);
    expect(runner.names).toHaveLength(5);
    const twin = q.job
      .name('mail.welcome.v1')
      .input(z.object({}))
      .handler(() => Promise.resolve({}));
    expect(() => jobsByName({ welcome, nested: { twin } })).toThrow(
      expect.objectContaining({ code: OUTBOX_ERROR_CODES.duplicateName }),
    );
    expect(() => jobsByName({ welcome, again: { welcome } })).not.toThrow();
  });

  it('assertJsonArgs refuses every non-JSON value and allows absent keys and shared references', () => {
    class Point {
      x = 1;
    }
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const refused: unknown[] = [
      undefined,
      { a: undefined },
      [1, undefined],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      () => 1,
      Symbol('s'),
      new Date(),
      new Map(),
      new Set(),
      new Point(),
      cycle,
    ];
    for (const value of refused)
      expect(() => assertJsonArgs(value, 1000, 'j'), String(typeof value)).toThrow(
        expect.objectContaining({ code: OUTBOX_ERROR_CODES.notJson }),
      );
    const shared = { a: 1 };
    expect(() => assertJsonArgs({ x: shared, y: shared, z: [shared] }, 1000, 'j')).not.toThrow();
    expect(() => assertJsonArgs({}, 1000, 'j')).not.toThrow();
    expect(() => assertJsonArgs(Object.create(null), 1000, 'j')).not.toThrow();
    expect(() => assertJsonArgs('éé', 6, 'j')).not.toThrow();
    expect(() => assertJsonArgs('éé', 5, 'j')).toThrow();
  });

  it('every error code has a remediation, and isOutboxError narrows', () => {
    for (const code of Object.values(OUTBOX_ERROR_CODES)) {
      const error: unknown = outboxError(code, 'm');
      expect(isOutboxError(error)).toBe(true);
      if (isOutboxError(error)) expect(error.remediation.length).toBeGreaterThan(20);
    }
    expect(isOutboxError(new Error('plain'))).toBe(false);
    expect(isOutboxError(Object.assign(new Error('x'), { code: 'OTHER', remediation: 'r' }))).toBe(false);
  });
});
