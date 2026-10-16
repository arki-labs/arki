// An effect's `retry` decides how a failed job runs again. It is the same `Backoff` the
// resilience policies and queue jobs take, so one retry rule reads the same everywhere.

import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, isFailure } from '@arki/failure';

import { backoff } from './index.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from './test-support.js';

class BadInput extends Error {}

let db: PgliteDatabase;
let client: PGlite;
let next = 0;
let failWith: Error | undefined;

const handlers = {
  OrderPaid: () => {
    if (failWith !== undefined) throw failWith;
  },
};
const slow = j.effect('slow-retry', order, handlers).withSchedule({ retry: backoff.constant(60_000).upTo(1) });
const picky = j
  .effect('picky-retry', order, handlers)
  .withSchedule({ retry: backoff.constant(1000).while(error => !(error instanceof BadInput)) });

const slowJournal = j.compose({ tables, effects: [slow] });
const pickyJournal = j.compose({ tables, effects: [picky] });

const CardDeclined = defineFailure('card.declined', {
  status: 402,
  data: z.object({ last4: z.string() }),
  message: 'card {last4} was declined',
});
const DbTimeout = defineFailure('db.timeout', { status: 503 });
let returnWith: unknown;
// A thrown error and a returned failure from the same handler, so the tests compare the two.
const charging = {
  OrderPaid: () => {
    if (returnWith instanceof Error) throw returnWith;
    return returnWith;
  },
};
// The default retry: 8 tries for a thrown error.
const charge = j.effect('charge-default-retry', order, charging);
const patient = j.effect('charge-timeout-retry', order, charging).withSchedule({
  retry: backoff
    .constant(1000)
    .upTo(3)
    .while(reason => isFailure(reason) && reason.code === 'db.timeout'),
});
const chargeJournal = j.compose({ tables, effects: [charge] });
const patientJournal = j.compose({ tables, effects: [patient] });

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

async function payOnce(
  journal: typeof slowJournal | typeof pickyJournal | typeof chargeJournal | typeof patientJournal,
) {
  const id = orderId(++next);
  await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
  const paid = await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }),
  );
  const [job] = await db
    .select()
    .from(tables.jobs)
    .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
  if (job === undefined) throw new Error('no job was written');
  return job;
}

async function failingDrain(journal: typeof slowJournal | typeof pickyJournal, error: Error) {
  failWith = error;
  try {
    expect(await journal.drain(db)).toBe(1);
  } finally {
    failWith = undefined;
  }
}

const jobById = async (id: string) => (await db.select().from(tables.jobs).where(eq(tables.jobs.id, id)))[0];

describe('effect retry from the schedule', () => {
  it('waits the backoff delay, then dies when upTo runs out', async () => {
    const job = await payOnce(slowJournal);
    const before = Date.now();
    await failingDrain(slowJournal, new Error('smtp down'));
    const retried = await jobById(job.id);
    expect(retried?.deadAt).toBeNull();
    // Due a minute from the database's now: at least 55 s from the test's clock, allowing for skew.
    expect(retried?.availableAt.getTime()).toBeGreaterThan(before + 55_000);

    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.id, job.id));
    await failingDrain(slowJournal, new Error('smtp down'));
    expect(await jobById(job.id)).toMatchObject({ attempts: 2, deadAt: expect.any(Date) });
  });

  it('dies at once when while() rejects the error, without using up its retries', async () => {
    const transient = await payOnce(pickyJournal);
    await failingDrain(pickyJournal, new Error('smtp down'));
    expect(await jobById(transient.id)).toMatchObject({ attempts: 1, deadAt: null });

    await db.delete(tables.jobs).where(eq(tables.jobs.id, transient.id));
    const bad = await payOnce(pickyJournal);
    await failingDrain(pickyJournal, new BadInput('no such customer'));
    expect(await jobById(bad.id)).toMatchObject({ attempts: 1, deadAt: expect.any(Date) });
  });
});

// A returned failure is an expected outcome: running the effect again repeats it, and may
// charge the customer again. So the job dies on the first try, with the failure on record,
// unless the effect's `while` names that failure as worth another try.
describe('an effect that returns a failure', () => {
  async function drainReturning(journal: typeof chargeJournal | typeof patientJournal, value: unknown) {
    returnWith = value;
    try {
      expect(await journal.drain(db)).toBe(1);
    } finally {
      returnWith = undefined;
    }
  }

  it('dies on the first try: a declined card is charged once, not 8 times', async () => {
    const job = await payOnce(chargeJournal);
    await drainReturning(chargeJournal, CardDeclined({ last4: '4242' }));
    expect(await jobById(job.id)).toMatchObject({ attempts: 1, deadAt: expect.any(Date) });
  });

  it('keeps code, message, status and data in lastError, so the dead-job list says why', async () => {
    const job = await payOnce(chargeJournal);
    await drainReturning(chargeJournal, CardDeclined({ last4: '4242' }));
    const dead = await jobById(job.id);
    expect(JSON.parse(dead?.lastError ?? 'null')).toMatchObject({
      code: 'card.declined',
      message: 'card 4242 was declined',
      status: 402,
      data: { last4: '4242' },
    });
  });

  it('runs again for a failure that while() accepts, and dies at once for one it does not', async () => {
    const timeout = await payOnce(patientJournal);
    await drainReturning(patientJournal, DbTimeout());
    expect(await jobById(timeout.id)).toMatchObject({ attempts: 1, deadAt: null });
    await db.delete(tables.jobs).where(eq(tables.jobs.id, timeout.id));

    const declined = await payOnce(patientJournal);
    await drainReturning(patientJournal, CardDeclined({ last4: '4242' }));
    expect(await jobById(declined.id)).toMatchObject({ attempts: 1, deadAt: expect.any(Date) });
  });

  it('a thrown error on the same effect still runs again: only a returned failure is final', async () => {
    const job = await payOnce(chargeJournal);
    await drainReturning(chargeJournal, new Error('gateway down'));
    expect(await jobById(job.id)).toMatchObject({ attempts: 1, deadAt: null, lastError: 'Error: gateway down' });
  });

  it('a plain result still acknowledges the job', async () => {
    const job = await payOnce(chargeJournal);
    await drainReturning(chargeJournal, { charged: true });
    expect(await jobById(job.id)).toBeUndefined();
  });
});
