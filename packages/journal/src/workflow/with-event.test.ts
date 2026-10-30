/**
 * `startOn.timing: 'with-event'`: the run, its first node and that node's job are written in the event's transaction.
 * Why it matters: when the command returns, a reader sees the run, and a rollback of the command leaves no run behind.
 * The body never runs inline, because no command runs inside another writer's transaction.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { defineFailure, InvalidInput, orThrow } from '@arki/failure';

import { JournalError } from '../errors.js';
import { initJournal } from '../journal.js';
import { j, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from '../test-support.js';
import { STEP_EFFECT } from './runner.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_caller' };
const bodies: string[] = [];

const Refused = defineFailure('test.refused', { status: 409, message: 'refused' });

const greet = j
  .workflow('test.greet', {
    version: 1,
    input: z.object({ orderId: z.string(), total: z.int() }),
    limits: { payload: 36 },
    startOn: {
      entity: order,
      event: OrderPlaced,
      timing: 'with-event',
      id: e => `greet:${e.entityId}`,
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .step('hello', ({ input }) => {
    bodies.push(input.orderId);
    return `hello ${input.orderId}`;
  })
  .finish();

/** Refuses or throws after the write, so the event's transaction rolls back. A big customer overflows the run's input. */
const place = j.command(
  'test.place',
  z.object({ n: z.int().positive(), ends: z.enum(['commits', 'refuses', 'throws']), total: z.int().optional() }),
  { writes: [OrderPlaced] },
  async (input, { write }) => {
    const written = await write(order, orderId(input.n), () => [
      OrderPlaced({ customerId: 'cus_1', total: input.total ?? input.n }),
    ]);
    if (input.ends === 'refuses') return Refused();
    if (input.ends === 'throws') throw new Error('the command dies after its write');
    return written;
  },
);

const journal = j.compose({ workflows: [greet], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

const runsOf = (runId: string) => db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
const stepsOf = (runId: string) => db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, runId));
const jobsOf = (runId: string) => db.select().from(tables.jobs).where(eq(tables.jobs.runId, runId));

async function settle(target: { drain: typeof journal.drain } = journal, limit = 20) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await target.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}

describe("startOn with timing 'with-event'", () => {
  it('writes the run, its first node and that job with the event, so a reader sees it when the command returns', async () => {
    orThrow(await journal.run(db, place, { n: 1, ends: 'commits' }, caller));

    const read = orThrow(await greet.read(db, 'greet:ord_1'));
    expect(read?.run).toMatchObject({ state: 'running', input: { orderId: 'ord_1', total: 1 } });
    expect(await stepsOf('greet:ord_1')).toMatchObject([{ path: 'hello', phase: 'do', status: 'scheduled' }]);
    const jobs = await jobsOf('greet:ord_1');
    expect(jobs.map(job => job.effect)).toEqual([STEP_EFFECT]);
    // The step row names its job, as for a run started by a job.
    const steps = await stepsOf('greet:ord_1');
    expect(steps[0]?.jobId).toBe(jobs[0]?.id);
    // No start job was needed, and no body ran inside the business transaction.
    expect(await db.select().from(tables.jobs).where(eq(tables.jobs.effect, 'workflow.start:test.greet'))).toEqual([]);
    expect(bodies).toEqual([]);

    await settle();
    expect(bodies).toEqual(['ord_1']);
    expect(await runsOf('greet:ord_1')).toMatchObject([{ state: 'completed', output: 'hello ord_1' }]);
  });

  it('removes the run when the command refuses or dies after the event, so no run outlives its reason', async () => {
    expect(await journal.run(db, place, { n: 2, ends: 'refuses' }, caller)).toMatchObject({ code: Refused.code });
    expect(TransactionDefect.is(await journal.run(db, place, { n: 3, ends: 'throws' }, caller))).toBe(true);

    for (const runId of ['greet:ord_2', 'greet:ord_3']) {
      expect(await runsOf(runId)).toEqual([]);
      expect(await stepsOf(runId)).toEqual([]);
      expect(await jobsOf(runId)).toEqual([]);
    }
    expect(await db.select().from(tables.events).where(eq(tables.events.entityId, 'greet:ord_2'))).toEqual([]);
  });

  it("records the app's workflowMeta and points at the event that started it, in the event's chain", async () => {
    orThrow(await journal.run(db, place, { n: 4, ends: 'commits' }, caller));
    const [placed] = await db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.entityId, 'ord_4'), eq(tables.events.type, 'OrderPlaced')));
    const [started] = await db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.entityId, 'greet:ord_4'), eq(tables.events.type, 'RunStarted')));
    expect(started?.meta).toEqual(workflowMeta);
    expect(placed?.meta).toEqual(caller);
    expect(started?.causeSeq).toBe(placed?.seq);
    expect(started?.correlationId).toBe(placed?.correlationId);
    expect(started?.commandId).toBe(placed?.commandId);
    await settle();
  });

  it('starts nothing for an id that already has a run, whatever its input, and the event commits', async () => {
    orThrow(await journal.run(db, greet.start, { id: 'greet:ord_5', input: { orderId: 'manual', total: 99 } }, caller));
    orThrow(await journal.run(db, place, { n: 5, ends: 'commits' }, caller));
    expect(await runsOf('greet:ord_5')).toMatchObject([{ input: { orderId: 'manual', total: 99 } }]);
    await settle();
  });

  it('refuses the write with the schema failure when the mapped input does not fit, and an oversized input rolls back too', async () => {
    const strict = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const positive = strict
      .workflow('test.positive', {
        version: 1,
        input: z.object({ total: z.int().negative() }),
        startOn: {
          entity: order,
          event: OrderPaid,
          timing: 'with-event',
          id: e => `positive:${e.entityId}`,
          input: e => ({ total: e.data.amount }),
        },
      })
      .step('a', () => 1)
      .finish();
    const strictJournal = strict.compose({ workflows: [positive], workflowMeta });
    orThrow(await journal.run(db, place, { n: 6, ends: 'commits' }, caller));
    await settle();
    const paid = await db.transaction(tx =>
      strictJournal.write(tx, order, orderId(6), { meta: caller, events: () => [OrderPaid({ amount: 5 })] }),
    );
    expect(InvalidInput.is(paid)).toBe(true);
    expect(await runsOf('positive:ord_6')).toEqual([]);

    // `limits.payload` is 36 bytes: this input is a bug in the mapping, so nothing commits, the order included.
    const huge = await journal.run(db, place, { n: 7, ends: 'commits', total: 2_147_483_647 }, caller);
    expect(TransactionDefect.is(huge)).toBe(true);
    expect(await runsOf('greet:ord_7')).toEqual([]);
    expect(await db.select().from(tables.events).where(eq(tables.events.entityId, 'ord_7'))).toEqual([]);
  });
});

describe("a limit in front of a 'with-event' start", () => {
  it('never refuses the business transaction: a paused limit queues the run, and resume starts it', async () => {
    const op = { actor: 'usr_op', reason: 'test' };
    orThrow(await journal.limits.pause(db, { name: 'workflow/test.greet' }, op));
    orThrow(await journal.run(db, place, { n: 8, ends: 'commits' }, caller));
    expect(await runsOf('greet:ord_8')).toMatchObject([{ state: 'queued' }]);
    expect(await stepsOf('greet:ord_8')).toEqual([]);

    orThrow(await journal.limits.resume(db, { name: 'workflow/test.greet' }, op));
    await settle();
    expect(await runsOf('greet:ord_8')).toMatchObject([{ state: 'completed' }]);
  });

  it("a join with no run to join queues too, and the run starts when a slot frees, though the workflow never says 'queue'", async () => {
    const own = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const shared = own.limit({ name: 'test.shared', total: 1 });
    const blocker = own
      .workflow('test.blocker', {
        version: 1,
        input: z.object({}),
        concurrency: { shared: [shared], onBusy: 'refuse' },
      })
      .waitFor('hold', { signal: 'go', schema: z.object({}) })
      .finish();
    const joiner = own
      .workflow('test.joiner', {
        version: 1,
        input: z.object({ orderId: z.string() }),
        concurrency: { key: input => input.orderId, limit: 1, shared: [shared], onBusy: 'join' },
        startOn: {
          entity: order,
          event: OrderPaid,
          timing: 'with-event',
          id: e => `joiner:${e.entityId}`,
          input: e => ({ orderId: e.entityId }),
        },
      })
      .step('a', () => 'done')
      .finish();
    const ownJournal = own.compose({ workflows: [blocker, joiner], workflowMeta });
    orThrow(await ownJournal.run(db, blocker.start, { id: 'blocker', input: {} }, caller));
    await settle(ownJournal);
    orThrow(await journal.run(db, place, { n: 9, ends: 'commits' }, caller));
    await settle();

    orThrow(
      await db.transaction(tx =>
        ownJournal.write(tx, order, orderId(9), { meta: caller, events: () => [OrderPaid({ amount: 1 })] }),
      ),
    );
    expect(await runsOf('joiner:ord_9')).toMatchObject([{ state: 'queued' }]);

    orThrow(
      await ownJournal.run(db, blocker.signal('go'), { runId: 'blocker', deliveryId: 'd1', payload: {} }, caller),
    );
    await settle(ownJournal);
    expect(await runsOf('joiner:ord_9')).toMatchObject([{ state: 'completed' }]);
  });
});

describe('startOn.timing, as a definition', () => {
  const input = z.object({});
  const fresh = () => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const base = { entity: order, event: OrderPlaced, id: () => 'x', input: () => ({}) };

  it('is required, for a caller the types do not reach', () => {
    // @ts-expect-error `timing` is required
    expect(() => fresh().workflow('test.notiming', { version: 1, input, startOn: base })).toThrow(
      /startOn.timing is required/,
    );
    expect(() =>
      fresh().workflow('test.notiming', { version: 1, input, startOn: { ...base, timing: 'after-commit' } }),
    ).not.toThrow();
  });

  it("refuses onBusy 'refuse' with 'with-event': a limit must not refuse the business transaction", () => {
    const concurrency = { total: 1, onBusy: 'refuse' } as const;
    const definition = () =>
      fresh().workflow('test.refusing', {
        version: 1,
        input,
        // @ts-expect-error `'refuse'` cannot sit in the business transaction
        concurrency,
        startOn: { ...base, timing: 'with-event' },
      });
    expect(definition).toThrow(JournalError);
    expect(definition).toThrow(/onBusy 'refuse'/);
    expect(() =>
      fresh().workflow('test.queueing', {
        version: 1,
        input,
        concurrency: { total: 1, onBusy: 'queue' },
        startOn: { ...base, timing: 'with-event' },
      }),
    ).not.toThrow();
  });

  it("a job queued before a workflow moved to 'with-event' still starts its run, and the workflow queues no new one", async () => {
    const before = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const after = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const definition = <Timing extends 'after-commit' | 'with-event'>(on: typeof before, timing: Timing) =>
      on
        .workflow('test.moved', {
          version: 1,
          input: z.object({ orderId: z.string() }),
          startOn: {
            entity: order,
            event: OrderPlaced,
            timing,
            id: e => `moved:${e.entityId}`,
            input: e => ({ orderId: e.entityId }),
          },
        })
        .step('a', () => 'done')
        .finish();
    const beforeJournal = before.compose({ workflows: [definition(before, 'after-commit')], workflowMeta });
    const afterJournal = after.compose({ workflows: [definition(after, 'with-event')], workflowMeta });

    const write = (journalOf: typeof beforeJournal, n: number) =>
      db.transaction(tx =>
        journalOf.write(tx, order, orderId(n), {
          meta: caller,
          events: () => [OrderPlaced({ customerId: 'c', total: n })],
        }),
      );
    orThrow(await write(beforeJournal, 20));
    expect(await runsOf('moved:ord_20')).toEqual([]);
    await settle(afterJournal);
    expect(await runsOf('moved:ord_20')).toMatchObject([{ state: 'completed' }]);

    orThrow(await write(afterJournal, 21));
    expect(await db.select().from(tables.jobs).where(eq(tables.jobs.effect, 'workflow.start:test.moved'))).toEqual([]);
    await settle(afterJournal);
  });
});
