/**
 * `startOn`: a journal event starts a workflow run. The start job is written in the event's transaction, so the run
 * starts once; it runs with the app's `workflowMeta`; and an id that already has a run starts nothing.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { JournalError } from '../errors.js';
import { initJournal } from '../journal.js';
import { j, openDb, order, orderId, OrderPlaced, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_caller' };
const START_JOB = 'workflow.start:test.welcome';

const welcome = j
  .workflow('test.welcome', {
    version: 1,
    input: z.object({ orderId: z.string(), total: z.int() }),
    startOn: {
      entity: order,
      event: OrderPlaced,
      id: e => `welcome:${e.entityId}`,
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .step('greet', ({ input }) => `hello ${input.orderId}`)
  .finish();

/** Places an order. With `dies`, it throws after the write, so its transaction (the event and its jobs) rolls back. */
const place = j.command(
  'test.place',
  z.object({ n: z.int().positive(), dies: z.boolean() }),
  async (input, { write }) => {
    const written = await write(order, orderId(input.n), () => [OrderPlaced({ customerId: 'cus_1', total: input.n })]);
    if (input.dies) throw new Error('the command dies after its write');
    return written;
  },
);

const journal = j.compose({ workflows: [welcome], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

async function settle(limit = 20) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}

const runsOf = (runId: string) =>
  db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
/** The finished start jobs of one order's events, by how they ended. */
const startJobsOf = (n: number) =>
  db
    .select({ outcome: tables.jobArchive.outcome })
    .from(tables.jobArchive)
    .innerJoin(tables.events, eq(tables.events.seq, tables.jobArchive.eventSeq))
    .where(and(eq(tables.events.entityId, orderId(n)), eq(tables.jobArchive.effect, START_JOB)));

describe('startOn', () => {
  it('an event starts the workflow once, even when the command that recorded it is retried', async () => {
    // The first try dies after its write: the journal returns the defect and rolls the event back.
    expect(isFailure(await journal.run(db, place, { n: 1, dies: true }, caller))).toBe(true);
    orThrow(await journal.run(db, place, { n: 1, dies: false }, caller));
    await settle();
    const runs = await runsOf('welcome:ord_1');
    expect(runs).toMatchObject([{ state: 'completed', input: { orderId: 'ord_1', total: 1 }, output: 'hello ord_1' }]);
    // The rolled-back try left no job: only the committed event made one.
    expect(await startJobsOf(1)).toEqual([{ outcome: 'completed' }]);
  });

  it("startOn uses the app's workflowMeta", async () => {
    orThrow(await journal.run(db, place, { n: 2, dies: false }, caller));
    await settle();
    const [started] = await db
      .select({ meta: tables.events.meta })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, 'welcome:ord_2'), eq(tables.events.type, 'RunStarted')));
    // Not the caller who placed the order: the run is started by the runner the app named.
    expect(started?.meta).toEqual(workflowMeta);
  });

  it('an event for an id that already has a run starts nothing, and its job ends done, not dead', async () => {
    // The same id, with another input: `def.start` would refuse it as a conflict.
    orThrow(
      await journal.run(db, welcome.start, { id: 'welcome:ord_3', input: { orderId: 'manual', total: 99 } }, caller),
    );
    orThrow(await journal.run(db, place, { n: 3, dies: false }, caller));
    await settle();
    expect(await runsOf('welcome:ord_3')).toMatchObject([{ input: { orderId: 'manual', total: 99 } }]);
    expect(await startJobsOf(3)).toEqual([{ outcome: 'completed' }]);
  });

  it('a startOn on a lower version is refused, because only the highest version starts runs', () => {
    const fresh = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const options = { input: z.object({ orderId: z.string() }) } as const;
    const startOn = { entity: order, event: OrderPlaced, id: () => 'x', input: () => ({ orderId: 'x' }) } as const;
    const v1 = fresh.workflow('test.versions', { ...options, version: 1, startOn }).step('a', () => 1).finish();
    const v2 = fresh.workflow('test.versions', { ...options, version: 2 }).step('a', () => 1).finish();
    let refused: unknown;
    try {
      fresh.compose({ workflows: [v1, v2], workflowMeta });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(JournalError);
    expect(refused).toMatchObject({ code: 'BAD_DEFINITION', message: expect.stringContaining('only the highest version') });
  });
});
