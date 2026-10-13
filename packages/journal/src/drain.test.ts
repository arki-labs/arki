import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OrderId } from './test-support.js';
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

  it('renews the lease while a long effect runs, so it is not claimed twice; a lost lease aborts the effect', async () => {
    // Why: AI and network effects run for minutes. Without renewal a second worker would take the
    // job after the lease and run it twice. With it, the only way to lose a job is to stall past a
    // whole lease, and then the effect must stop, because another worker owns the job now.
    const seen: string[] = [];
    const slow = j.effect('slow-mail', order, {
      OrderPaid: async (e, { signal }) => {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1300);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        seen.push(signal.aborted ? `${e.entityId}:aborted` : e.entityId);
      },
    });
    const slowJournal = j.compose({ tables, effects: [slow] });
    const place = (id: OrderId) =>
      db.transaction(tx =>
        slowJournal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      );
    const pay = (id: OrderId) =>
      db.transaction(tx => slowJournal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }));
    const leaseOf = async (effect: string) => {
      const rows = await db.select().from(tables.jobs).where(eq(tables.jobs.effect, effect));
      return rows[0];
    };

    // Lease of one second, renewed every 500 ms; the effect takes 1.3 s and finishes once.
    const first = orderId(++next);
    await place(first);
    await pay(first);
    const draining = slowJournal.drain(db, { leaseSeconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 700));
    const midway = await leaseOf('slow-mail');
    expect(midway?.leaseUntil?.getTime(), 'the lease was pushed past its first expiry').toBeGreaterThan(
      Date.now() + 200,
    );
    expect(await draining).toBe(1);
    expect(seen).toEqual([first]);
    expect(await leaseOf('slow-mail')).toBeUndefined();

    // Another worker took the job (the token changed): the next renewal aborts the effect.
    const second = orderId(++next);
    await place(second);
    await pay(second);
    const draining2 = slowJournal.drain(db, { leaseSeconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 200));
    await db.update(tables.jobs).set({ leaseToken: 'other-worker' }).where(eq(tables.jobs.effect, 'slow-mail'));
    expect(await draining2).toBe(1);
    expect(seen).toEqual([first, `${second}:aborted`]);
    // Not acknowledged by this worker: the row is still there, under the other token.
    expect(await leaseOf('slow-mail')).toMatchObject({ leaseToken: 'other-worker' });
    await db.delete(tables.jobs).where(eq(tables.jobs.effect, 'slow-mail'));
  }, 15_000);

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

describe('effect context: run', () => {
  const system = { actorId: 'system' };
  const payOrder = j.command(
    'payOrder',
    z.object({ id: z.templateLiteral(['ord_', z.string()]), fail: z.boolean().default(false) }),
    async (input, { write }) => {
      await write(order, input.id, () => [OrderPaid({ amount: 1 })]);
      if (input.fail) throw new Error('refused after the write');
    },
  );

  /** Places an order in a transaction of the test: a job is queued and no worker is woken. */
  const place = async (on: ReturnType<typeof j.compose>) => {
    const id = orderId(++next);
    await db.transaction(tx =>
      on.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    );
    return id;
  };
  const statusOf = async (id: OrderId) => {
    const rows = await db.select().from(orders).where(eq(orders.id, id));
    return rows[0]?.status;
  };
  const eventsOf = (id: OrderId) =>
    db.select().from(tables.events).where(eq(tables.events.entityId, id)).orderBy(asc(tables.events.seq));
  const jobOf = async (effect: string) => {
    const rows = await db.select().from(tables.jobs).where(eq(tables.jobs.effect, effect));
    return rows[0];
  };

  // Paying an order is a reaction to placing it; the receipt is a reaction to the payment.
  const receipts: OrderId[] = [];
  const waiting = new Map<OrderId, () => void>();
  const payOnPlace = j.effect('chain-pay-on-place', order, {
    OrderPlaced: (e, { run }) => run(payOrder, { id: e.entityId }, system),
  });
  const receipt = j.effect('chain-receipt', order, {
    OrderPaid: e => {
      receipts.push(e.entityId);
      waiting.get(e.entityId)?.();
    },
  });
  const chain = j.compose({ tables, effects: [payOnPlace, receipt] });

  it('runs a command on the root database and commits it under the meta the effect passed, so a reaction needs no closure over the journal', async () => {
    const auto = j.compose({
      tables,
      effects: [
        j.effect('run-pay-on-place', order, {
          OrderPlaced: (e, { run }) => run(payOrder, { id: e.entityId }, system),
        }),
      ],
    });
    const id = await place(auto);
    expect(await auto.drain(db)).toBe(1);
    expect(await statusOf(id)).toBe('paid');
    const events = await eventsOf(id);
    expect(events.map(event => [event.type, event.meta])).toEqual([
      ['OrderPlaced', meta],
      ['OrderPaid', system],
    ]);
    // The reaction is stamped with its cause: the event the job was for, and that event's chain.
    const [placed, paid] = events;
    expect(paid?.causeSeq).toBe(placed?.seq);
    expect(paid?.correlationId).toBe(placed?.correlationId);
    expect(paid?.commandId).toMatch(/^cmd_/);
    expect(placed?.causeSeq).toBeNull();
  });

  it('queues a job for the command it ran and the next claim runs it, so one reaction can start the next', async () => {
    const id = await place(chain);
    expect(await chain.drain(db, { batchSize: 1 })).toBe(1);
    // The receipt job was queued by the job this pass ran, so it waits for the next claim.
    expect(receipts).not.toContain(id);
    expect(await chain.drain(db, { batchSize: 1 })).toBe(1);
    expect(receipts).toContain(id);
  });

  it('claims a job queued during the pass in the same pass, because each job is claimed just before it runs', async () => {
    const id = await place(chain);
    expect(await chain.drain(db)).toBe(2);
    expect(receipts).toContain(id);
  });

  it('wakes a sleeping worker for the job the command queued, so the next reaction does not wait for the poll', async () => {
    // The worker polls once a minute: a receipt inside the test's time came from a wake.
    const passes = vi.spyOn(chain, 'drain');
    const worker = chain.worker(db, { pollMs: 60_000 });
    try {
      await worker.start();
      // Its first pass finds nothing, so it sleeps.
      await passes.mock.results[0]?.value;
      const id = await place(chain);
      const done = new Promise<void>(resolve => {
        waiting.set(id, resolve);
      });
      // This pass runs the paying effect by hand and claims nothing more, so the
      // receipt job is left for the worker, which hears only the wake.
      expect(await chain.drain(db, { batchSize: 1 })).toBe(1);
      await done;
      expect(receipts).toContain(id);
    } finally {
      await worker.stop();
      passes.mockRestore();
    }
  }, 2000);

  it('fails the job when the command throws: it stays to retry with the error stored, and nothing the command wrote is committed', async () => {
    const failing = j.compose({
      tables,
      effects: [
        j.effect('run-pay-fails', order, {
          OrderPlaced: (e, { run }) => run(payOrder, { id: e.entityId, fail: true }, system),
        }),
      ],
    });
    const id = await place(failing);
    expect(await failing.drain(db)).toBe(1);
    const job = await jobOf('run-pay-fails');
    expect(job).toMatchObject({ attempts: 1, leaseToken: null, deadAt: null });
    expect(job?.lastError).toContain('refused after the write');
    expect(job?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await statusOf(id)).toBe('placed');
    const events = await eventsOf(id);
    expect(events.map(event => event.type)).toEqual(['OrderPlaced']);
  });

  it('keeps the command committed when the effect throws after it and retries the job, so the handler must be safe to run twice', async () => {
    const halfDone = j.compose({
      tables,
      effects: [
        j.effect('run-pay-then-fail', order, {
          OrderPlaced: async (e, { run }) => {
            await run(payOrder, { id: e.entityId }, system);
            throw new Error('mail down after the payment');
          },
        }),
      ],
    });
    const id = await place(halfDone);
    expect(await halfDone.drain(db)).toBe(1);
    const job = await jobOf('run-pay-then-fail');
    expect(job).toMatchObject({ attempts: 1, leaseToken: null, deadAt: null });
    expect(job?.lastError).toContain('mail down after the payment');
    expect(await statusOf(id)).toBe('paid');
  });
});

const placeOn = async (target: typeof journal) => {
  const id = orderId(++next);
  await db.transaction(tx =>
    target.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
};
const jobsOf = (effect: string) => db.select().from(tables.jobs).where(eq(tables.jobs.effect, effect));

describe('claiming, stopping and stranded jobs', () => {
  it('claims each job right before it runs, so a slow first job cannot let the lease of a later one run out', async () => {
    // A batch claimed up front starts every lease at once. If the first jobs
    // are slow, the last leases expire before those jobs start, and a second
    // worker takes them: the side effect would happen twice.
    const othersClaimed: boolean[] = [];
    const probe = j.compose({
      tables,
      effects: [
        j.effect('lease-probe', order, {
          OrderPlaced: async (_e, { jobId }) => {
            const rows = await jobsOf('lease-probe');
            othersClaimed.push(rows.some(row => row.id !== jobId && row.leaseToken !== null));
          },
        }),
      ],
    });
    await placeOn(probe);
    await placeOn(probe);
    expect(await probe.drain(db)).toBe(2);
    expect(othersClaimed).toEqual([false, false]);
  });

  it('claims no further job once the signal is aborted; the running job still finishes and sees the abort', async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    const probe = j.compose({
      tables,
      effects: [
        j.effect('abort-probe', order, {
          OrderPlaced: (_e, { signal }) => {
            controller.abort();
            seen.push(signal.aborted);
          },
        }),
      ],
    });
    await placeOn(probe);
    await placeOn(probe);
    expect(await probe.drain(db, { signal: controller.signal })).toBe(1);
    expect(seen).toEqual([true]);
    const left = await jobsOf('abort-probe');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ attempts: 0, leaseToken: null });
    // Untouched, so the next drain takes it.
    expect(await probe.drain(db)).toBe(1);
  });

  it('worker.stop() aborts the running effect’s signal and waits for it, so a long effect can end early on shutdown', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const slow = j.compose({
      tables,
      effects: [
        j.effect('slow-effect', order, {
          OrderPlaced: (_e, { signal }) =>
            new Promise<void>(resolve => {
              markStarted?.();
              signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        }),
      ],
    });
    await placeOn(slow);
    const worker = slow.worker(db, { pollMs: 10 });
    await worker.start();
    await started;
    // Without the abort this never resolves: the effect waits for the signal.
    await worker.stop();
    expect(await jobsOf('slow-effect')).toEqual([]);
  });

  it('strandedJobs lists pending jobs whose effect the journal does not have, so a renamed effect is visible', async () => {
    // The jobs stay unclaimed on purpose (an older worker may still have the
    // effect during a rolling deploy), so a count is the only way to see them.
    const oldName = j.compose({
      tables,
      effects: [j.effect('old-effect-name', order, { OrderPlaced: () => Promise.resolve() })],
    });
    await placeOn(oldName);
    const stranded = await journal.strandedJobs(db);
    expect(stranded).toContainEqual({ effect: 'old-effect-name', jobs: 1 });
    expect(stranded.map(row => row.effect)).not.toContain('order-mail');
    const strandedForOwner = await oldName.strandedJobs(db);
    expect(strandedForOwner.map(row => row.effect)).not.toContain('old-effect-name');
  });
});
