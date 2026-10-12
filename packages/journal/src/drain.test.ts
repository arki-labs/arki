import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

const calls: { jobId: string; type: string; signalAborted: boolean }[] = [];
let failMail = false;

const mail = j.effect('order-mail', order, {
  OrderPaid: (e, { jobId, signal }) => {
    calls.push({ jobId, type: e.type, signalAborted: signal.aborted });
    if (failMail) throw new Error('smtp down');
  },
});

const journal = j.compose({ tables, effects: [mail] });

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const placeAndPay = async () => {
  const id = orderId(++next);
  await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
  const paid = await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }),
  );
  const seq = paid.events[0]?.seq ?? -1;
  const [job] = await db.select().from(tables.jobs).where(eq(tables.jobs.eventSeq, seq));
  if (job === undefined) throw new Error('no job row');
  return job;
};

const jobById = async (id: string) => {
  const rows = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
  return rows[0] ?? null;
};

describe('drain', () => {
  it('runs the handler with the event and the job id, then deletes the job', async () => {
    const job = await placeAndPay();
    expect(await journal.drain(db)).toBe(1);
    expect(calls.at(-1)).toEqual({ jobId: job.id, type: 'OrderPaid', signalAborted: false });
    expect(await jobById(job.id)).toBeNull();
  });

  it('on failure keeps the job, stores the error, and backs off so the next drain skips it', async () => {
    const job = await placeAndPay();
    failMail = true;
    try {
      expect(await journal.drain(db)).toBe(1);
    } finally {
      failMail = false;
    }
    const after = await jobById(job.id);
    expect(after).toMatchObject({ attempts: 1, leaseToken: null, deadAt: null });
    expect(after?.lastError).toContain('smtp down');
    expect(after?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await journal.drain(db)).toBe(0);

    // Once the backoff passes, the job runs again and succeeds.
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.id, job.id));
    expect(await journal.drain(db)).toBe(1);
    expect(await jobById(job.id)).toBeNull();
  });

  it('marks a job dead after the last allowed attempt instead of retrying forever', async () => {
    const job = await placeAndPay();
    await db.update(tables.jobs).set({ attempts: 7 }).where(eq(tables.jobs.id, job.id));
    failMail = true;
    try {
      expect(await journal.drain(db)).toBe(1);
    } finally {
      failMail = false;
    }
    const dead = await jobById(job.id);
    expect(dead?.attempts).toBe(8);
    expect(dead?.deadAt).toBeInstanceOf(Date);
    expect(await journal.drain(db)).toBe(0);
    expect(await jobById(job.id)).not.toBeNull();
  });

  it('re-claims a job whose lease expired, as a crashed worker would leave it', async () => {
    const job = await placeAndPay();
    await db
      .update(tables.jobs)
      .set({ leaseToken: 'stale', leaseUntil: new Date(Date.now() + 60_000), attempts: 1 })
      .where(eq(tables.jobs.id, job.id));
    expect(await journal.drain(db)).toBe(0);
    await db
      .update(tables.jobs)
      .set({ leaseUntil: new Date(Date.now() - 1) })
      .where(eq(tables.jobs.id, job.id));
    expect(await journal.drain(db)).toBe(1);
    expect(await jobById(job.id)).toBeNull();
  });

  it('leaves a job for an unknown effect pending and untouched', async () => {
    const job = await placeAndPay();
    await db.update(tables.jobs).set({ effect: 'retired-effect' }).where(eq(tables.jobs.id, job.id));
    expect(await journal.drain(db)).toBe(0);
    expect(await jobById(job.id)).toMatchObject({ effect: 'retired-effect', attempts: 0, leaseToken: null });
  });

  it('a claimed job whose effect no longer handles the event type fails and retries; it is never dropped', async () => {
    // A deploy can narrow an effect while jobs for the old type are still queued.
    // Dropping them would lose the side effect for good.
    const job = await placeAndPay();
    const narrowed = j.compose({
      tables,
      effects: [
        j.effect('order-mail', order, {
          OrderCancelled: () => {
            /* not the event that was queued */
          },
        }),
      ],
    });
    expect(await narrowed.drain(db)).toBe(1);
    const after = await jobById(job.id);
    expect(after).toMatchObject({ attempts: 1, leaseToken: null, deadAt: null });
    expect(after?.lastError).toContain('OrderPaid');
    // A deploy that brings the handler back finishes the job.
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.id, job.id));
    expect(await journal.drain(db)).toBe(1);
    expect(await jobById(job.id)).toBeNull();
  });

  it('drain and worker refuse a transaction handle: effects must run only after the outer commit', async () => {
    await db.transaction(async tx => {
      // @ts-expect-error -- a transaction is not the root database
      await expect(journal.drain(tx)).rejects.toThrow(/root database/);
      // @ts-expect-error -- a transaction is not the root database
      expect(() => journal.worker(tx)).toThrow(/root database/);
    });
  });

  // Clock-skew tests live in journal.pg.test.ts: PGlite's `now()` runs on the JS clock,
  // so faking `Date` there moves both clocks at once.

  it('respects the batch limit and reports the number claimed', async () => {
    await placeAndPay();
    await placeAndPay();
    await placeAndPay();
    expect(await journal.drain(db, { batchSize: 2 })).toBe(2);
    expect(await journal.drain(db, { batchSize: 2 })).toBe(1);
  });

  it('a journal without effects drains nothing', async () => {
    const bare = j.compose({ tables });
    expect(await bare.drain(db)).toBe(0);
  });
});

describe('worker', () => {
  it('start drains pending jobs; stop waits for the loop to finish', async () => {
    const job = await placeAndPay();
    const worker = journal.worker(db, { pollMs: 10 });
    await worker.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    await worker.stop();
    expect(await jobById(job.id)).toBeNull();
    // After stop nothing runs: a new job stays pending.
    const later = await placeAndPay();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await jobById(later.id)).not.toBeNull();
    await worker.stop();
  });
});

describe('effect context', () => {
  it('gives the handler the root database passed to drain, so an effect reads committed rows without a closure', async () => {
    const seen: { db?: unknown; status?: string } = {};
    const audit = j.effect('order-audit', order, {
      OrderPaid: async (e, ctx) => {
        seen.db = ctx.db;
        const [row] = await ctx.db.select().from(orders).where(eq(orders.id, e.entityId));
        seen.status = row?.status;
      },
    });
    // Its own journal: a job names its effect, so the tests above never see this one.
    const auditJournal = j.compose({ tables, effects: [audit] });
    const id = orderId(++next);
    await db.transaction(tx =>
      auditJournal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    );
    await db.transaction(tx => auditJournal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }));
    expect(await auditJournal.drain(db)).toBe(1);
    expect(seen.db).toBe(db);
    expect(seen.status).toBe('paid');
  });
});
