/**
 * Child and map nodes on PGlite: a parent starts child runs, waits for them, and gets their typed output. A child's
 * end wakes the parent in the same commit. Cancel and compensation reach the children. Races between two real
 * connections are in `children.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { backoff } from '@arki/resilience';

import type { WorkflowDef } from './define.js';
import { JournalError } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const noRetry = backoff.constant(0).upTo(0);
const Go = z.object({});

/** Every do and undo that ran, in order. */
const log: string[] = [];

/** Holds a slot, undoes it, and waits for `go`. Its output is the slot. */
const reserving = j
  .workflow('test.kid.reserving', { version: 1, input: z.object({ n: z.int() }) })
  .step('hold', ({ input }) => ({ slot: input.n }), { undo: ({ result }) => void log.push(`release ${result.slot}`) })
  .waitFor('go', { signal: 'go', schema: Go })
  .step('done', ({ results }) => ({ slot: results.hold.slot }))
  .finish();

/** Finishes at once. */
const doubler = j
  .workflow('test.kid.doubler', { version: 1, input: z.object({ n: z.int() }) })
  .step('work', ({ input }) => ({ doubled: input.n * 2 }))
  .finish();

/** Ends `failed`: its only step fails and the run compensates. */
const failingKid = j
  .workflow('test.kid.failing', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step(
    'boom',
    () => {
      throw new Error('kid broke');
    },
    { retry: noRetry },
  )
  .finish();

const single = j
  .workflow('test.parent.single', { version: 1, input: z.object({ n: z.int() }) })
  .step('before', () => 'ready', { undo: () => void log.push('undo before') })
  .child('kid', doubler, { input: ({ input }) => ({ n: input.n }) })
  .step('after', ({ results }) => ({ got: results.kid.doubled, before: results.before }))
  .finish();

const batch = j
  .workflow('test.parent.batch', { version: 1, input: z.object({ ns: z.array(z.int()) }) })
  .map('fan', reserving, { items: ({ input }) => input.ns, input: (_ctx, n) => ({ n }) })
  .finish(({ results }) => results.fan.map(kid => kid.slot));

const limited = j
  .workflow('test.parent.limited', { version: 1, input: z.object({ ns: z.array(z.int()) }), limits: { children: 3 } })
  .map('fan', doubler, { items: ({ input }) => input.ns, input: (_ctx, n) => ({ n }) })
  .finish();

const limitedByTwo = j
  .workflow('test.parent.concurrent', { version: 1, input: z.object({ ns: z.array(z.int()) }) })
  .map('fan', reserving, { items: ({ input }) => input.ns, input: (_ctx, n) => ({ n }), concurrency: 2 })
  .finish(({ results }) => results.fan.map(kid => kid.slot));

const race = j
  .workflow('test.parent.race', { version: 1, input: z.object({ ns: z.array(z.int()) }) })
  .map('first', reserving, { items: ({ input }) => input.ns, input: (_ctx, n) => ({ n }), wait: 'any' })
  .step('after', ({ results }) => {
    log.push('after the join');
    return results.first.slot;
  })
  .finish();

const failingBatch = j
  .workflow('test.parent.failingbatch', { version: 1, input: z.object({}) })
  .map('fan', failingKid, { items: () => [1, 2], input: () => ({}) })
  .finish();
const failingWaits = j
  .workflow('test.parent.failing.wait', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .child('kid', failingKid, { input: () => ({}) })
  .finish();
const failingCompensates = j
  .workflow('test.parent.failing.compensate', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .child('kid', failingKid, { input: () => ({}) })
  .finish();

/** A step with an undo, a child that waits, and a step after it. */
const waiting = j
  .workflow('test.parent.waiting', { version: 1, input: z.object({}) })
  .step('before', () => 'ready', { undo: () => void log.push('undo before') })
  .child('kid', reserving, { input: () => ({ n: 1 }) })
  .waitFor('confirm', { signal: 'confirm', schema: Go })
  .finish();
const detaching = j
  .workflow('test.parent.detaching', { version: 1, input: z.object({}) })
  .step('before', () => 'ready', { undo: () => void log.push('undo before') })
  .child('kid', reserving, { input: () => ({ n: 1 }), onCancel: 'detach' })
  .waitFor('confirm', { signal: 'confirm', schema: Go })
  .finish();
const withNodeUndo = j
  .workflow('test.parent.nodeundo', { version: 1, input: z.object({}) })
  .child('kid', reserving, {
    input: () => ({ n: 1 }),
    undo: ({ result }) => void log.push(`undo node ${result.slot}`),
  })
  .waitFor('confirm', { signal: 'confirm', schema: Go })
  .finish();

/** `nest0` has `nest1` as a child, and so on down to a leaf: the run at the bottom has nine ancestors. */
let chain: WorkflowDef = j
  .workflow('test.nest.leaf', { version: 1, input: z.object({}) })
  .step('work', () => 'leaf')
  .finish();
const chainDefs: WorkflowDef[] = [chain];
for (let level = 8; level >= 1; level--) {
  chain = j
    .workflow(`test.nest.${level}`, { version: 1, input: z.object({}) })
    .child('c', chain, { input: () => ({}) })
    .finish();
  chainDefs.unshift(chain);
}
const nest = j
  .workflow('test.nest.0', { version: 1, input: z.object({}) })
  .child('c', chain, { input: () => ({}) })
  .finish();
chainDefs.unshift(nest);

const journal = j.compose({
  workflows: [
    reserving,
    doubler,
    failingKid,
    single,
    batch,
    limited,
    limitedByTwo,
    race,
    failingBatch,
    failingWaits,
    failingCompensates,
    waiting,
    detaching,
    withNodeUndo,
    ...chainDefs,
  ],
  workflowMeta,
});

/** The first checkpoints that park a parent on its children roll back after they ran: as if the worker died there. */
let dieAfterParking = 0;
journal.hooks.command.around(async (ctx, next) => {
  await next();
  const parking = z.object({ outcome: z.object({ kind: z.literal('children') }) }).safeParse(ctx.input);
  if (parking.success && dieAfterParking-- > 0) throw new JournalError('LEASE_LOST', 'job', 'test', 'the worker died after the checkpoint');
});

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());
beforeEach(() => {
  log.length = 0;
});

async function settle(limit = 60) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db)) === 0) return;
  }
  throw new Error('the runs did not settle');
}
const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};
const rowOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
const stateOf = async (id: string) => {
  const row = await rowOf(id);
  return row?.state;
};
const eventTypes = async (id: string) => {
  const found = await db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return found.map(event => event.type);
};
const kidsOf = (id: string) =>
  db
    .select()
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.parentId, id))
    .orderBy(asc(tables.workflowRuns.id));
const kidIds = async (id: string) => {
  const kids = await kidsOf(id);
  return kids.map(kid => kid.id);
};
const kidStates = async (id: string) => {
  const kids = await kidsOf(id);
  return kids.map(kid => kid.state);
};
const aliveCount = async (id: string) => {
  const kids = await kidsOf(id);
  return kids.filter(kid => kid.finishedAt === null).length;
};
const eventsOfType = async (id: string, type: string) => {
  const types = await eventTypes(id);
  return types.filter(seen => seen === type);
};
const stepOf = async (id: string, path: string, phase: 'do' | 'undo') => {
  const [step] = await db
    .select()
    .from(tables.workflowSteps)
    .where(
      and(
        eq(tables.workflowSteps.runId, id),
        eq(tables.workflowSteps.path, path),
        eq(tables.workflowSteps.phase, phase),
      ),
    );
  return step;
};
const errorOf = async (id: string, path: string, phase: 'do' | 'undo') => {
  const step = await stepOf(id, path, phase);
  return step?.error;
};
const go = (def: typeof reserving, runId: string) =>
  journal.run(db, def.signal('go'), { runId, deliveryId: `go_${runId}`, payload: {} }, caller);

describe('a child node', () => {
  it('the parent waits for its child and gets the child typed output', async () => {
    const id = newId('single');
    expectOk(await journal.run(db, single.start, { input: { n: 7 }, id }, caller));
    await settle();
    const parent = await rowOf(id);
    expect(parent).toMatchObject({ state: 'completed', output: { got: 14, before: 'ready' } });
    const [kid] = await kidsOf(id);
    // The child id is derived from the parent and the node, so a re-run finds the same child.
    expect(kid).toMatchObject({ id: `${id}/kid`, parentId: id, parentPath: 'kid', state: 'completed' });
    expect(parent?.results).toMatchObject({ kid: { doubled: 14 } });
  });

  it('retrying a parent does not create another child', async () => {
    const id = newId('single');
    dieAfterParking = 1;
    expectOk(await journal.run(db, single.start, { input: { n: 1 }, id }, caller));
    await settle();
    expect(await kidsOf(id)).toEqual([]);
    expect(await eventTypes(id)).not.toContain('ChildrenPlanned');
    // The simulated interruption is permanent until an operator explicitly resumes the job.
    expectOk(await journal.workflows.retryStep(db, { runId: id, path: 'kid', phase: 'do' }, { actor: 'test' }));
    await db
      .update(tables.jobs)
      .set({ availableAt: sql`${tables.jobs.availableAt} - interval '1 hour'` })
      .where(eq(tables.jobs.runId, id));
    await settle();
    expect(await kidsOf(id)).toHaveLength(1);
    expect(await eventsOfType(id, 'ChildrenPlanned')).toHaveLength(1);
    expect(await stateOf(id)).toBe('completed');
  });
});

describe('a map node', () => {
  it('map waits for all children and keeps item order', async () => {
    const id = newId('batch');
    expectOk(await journal.run(db, batch.start, { input: { ns: [10, 20, 30] }, id }, caller));
    await settle();
    expect(await kidsOf(id)).toHaveLength(3);
    expect(await stateOf(id)).toBe('parked');
    // The last item finishes first: the result still follows the items.
    for (const index of [2, 0]) expectOk(await go(reserving, `${id}/fan[${index}]`));
    await settle();
    expect(await stateOf(id)).toBe('parked');
    expectOk(await go(reserving, `${id}/fan[1]`));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: [10, 20, 30] });
  });

  it('map concurrency starts at most n children at once', async () => {
    const id = newId('conc');
    expectOk(await journal.run(db, limitedByTwo.start, { input: { ns: [1, 2, 3, 4, 5] }, id }, caller));
    await settle();
    const alive = async () => await aliveCount(id);
    expect(await kidIds(id)).toEqual([`${id}/fan[0]`, `${id}/fan[1]`]);
    for (const index of [0, 1, 2, 3]) {
      expectOk(await go(reserving, `${id}/fan[${index}]`));
      await settle();
      expect(await alive()).toBeLessThanOrEqual(2);
      expect(await kidsOf(id)).toHaveLength(Math.min(index + 3, 5));
    }
    expectOk(await go(reserving, `${id}/fan[4]`));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: [1, 2, 3, 4, 5] });
  });

  it('any join cancels the losers before the scope completes', async () => {
    const id = newId('race');
    expectOk(await journal.run(db, race.start, { input: { ns: [1, 2, 3] }, id }, caller));
    await settle();
    expectOk(await go(reserving, `${id}/first[1]`));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: 2 });
    expect(await kidStates(id)).toEqual(['cancelled', 'completed', 'cancelled']);
    // Each loser cleaned up (released its slot) before the step after the join ran.
    expect(log).toEqual(expect.arrayContaining(['release 1', 'release 3']));
    expect(log.indexOf('after the join')).toBeGreaterThan(Math.max(log.indexOf('release 1'), log.indexOf('release 3')));
  });

  it('items over limits.children make the node dead, not a thousand runs', async () => {
    const id = newId('limited');
    expectOk(await journal.run(db, limited.start, { input: { ns: [1, 2, 3, 4] }, id }, caller));
    await settle();
    expect(await kidsOf(id)).toEqual([]);
    expect(await stepOf(id, 'fan', 'do')).toMatchObject({ status: 'failed' });
    expect(await errorOf(id, 'fan', 'do')).toContain('limits.children is 3');
  });

  it('a map over no items is done at once', async () => {
    const id = newId('empty');
    expectOk(await journal.run(db, batch.start, { input: { ns: [] }, id }, caller));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: [] });
  });
});

describe('a failed child', () => {
  it('a failed child makes the parent node dead and onDeadStep decides', async () => {
    const waits = newId('failwait');
    expectOk(await journal.run(db, failingWaits.start, { input: {}, id: waits }, caller));
    await settle();
    expect(await stateOf(`${waits}/kid`)).toBe('failed');
    // `wait` (the default): the node is dead, the run stays for an operator and undoes nothing.
    expect(await stepOf(waits, 'kid', 'do')).toMatchObject({ status: 'failed' });
    expect(await stateOf(waits)).toBe('parked');
    expect(log).not.toContain('undo charge');

    const compensates = newId('failcomp');
    expectOk(await journal.run(db, failingCompensates.start, { input: {}, id: compensates }, caller));
    await settle();
    expect(await stateOf(compensates)).toBe('failed');
    expect(log).toContain('undo charge');
  });

  it('map all: the first failed child kills the node and its siblings keep running', async () => {
    const id = newId('failbatch');
    expectOk(await journal.run(db, failingBatch.start, { input: {}, id }, caller));
    await settle();
    expect(await stepOf(id, 'fan', 'do')).toMatchObject({ status: 'failed' });
    expect(await kidStates(id)).toEqual(['failed', 'failed']);
    expect(await eventsOfType(id, 'NodeFailed')).toHaveLength(1);
  });

  it('a child someone else cancels is a failed child for its parent', async () => {
    const id = newId('stolen');
    expectOk(await journal.run(db, waiting.start, { input: {}, id }, caller));
    await settle();
    expectOk(await journal.run(db, reserving.cancel, { runId: `${id}/kid`, reason: 'an operator did' }, caller));
    await settle();
    expect(await stateOf(`${id}/kid`)).toBe('cancelled');
    expect(await stepOf(id, 'kid', 'do')).toMatchObject({ status: 'failed' });
  });
});

describe('cancel and compensation', () => {
  it('cancel propagates to children and the parent waits for them', async () => {
    const id = newId('cancel');
    expectOk(await journal.run(db, waiting.start, { input: {}, id }, caller));
    await settle();
    const stopped = await journal.run(db, waiting.cancel, { runId: id, reason: 'stop' }, caller);
    // The child had a step to undo, so it is not over yet and neither is the parent.
    expect(stopped).toEqual({ state: 'compensating' });
    expect(await stateOf(`${id}/kid`)).toBe('compensating');
    expect(log).toEqual([]);
    await settle();
    expect(log).toEqual(['release 1', 'undo before']);
    expect(await stateOf(`${id}/kid`)).toBe('cancelled');
    expect(await stateOf(id)).toBe('cancelled');
  });

  it('a detached child is left alone on cancel and compensation', async () => {
    const live = newId('detached');
    expectOk(await journal.run(db, detaching.start, { input: {}, id: live }, caller));
    await settle();
    expectOk(await journal.run(db, detaching.cancel, { runId: live, reason: 'stop' }, caller));
    await settle();
    // The parent did not wait for the child, and did not touch it.
    expect(await stateOf(live)).toBe('cancelled');
    expect(await stateOf(`${live}/kid`)).toBe('parked');
    expect(log).toEqual(['undo before']);

    log.length = 0;
    const done = newId('detached');
    expectOk(await journal.run(db, detaching.start, { input: {}, id: done }, caller));
    await settle();
    expectOk(await go(reserving, `${done}/kid`));
    await settle();
    expectOk(await journal.run(db, detaching.cancel, { runId: done, reason: 'stop' }, caller));
    await settle();
    expect(await stateOf(`${done}/kid`)).toBe('completed');
    expect(log).toEqual(['undo before']);
    // Nothing was done for the child node: it is recorded as left over, for an operator to see.
    expect(await stepOf(done, 'kid', 'undo')).toMatchObject({ status: 'skipped' });
  });

  it('a completed child is compensated through its own undos when the parent compensates', async () => {
    const id = newId('reopen');
    expectOk(await journal.run(db, waiting.start, { input: {}, id }, caller));
    await settle();
    expectOk(await go(reserving, `${id}/kid`));
    await settle();
    expect(await stateOf(`${id}/kid`)).toBe('completed');
    expect(await stateOf(id)).toBe('parked');
    expectOk(await journal.run(db, waiting.cancel, { runId: id, reason: 'stop' }, caller));
    // The child is reopened first (it came last), then the parent's own step is undone.
    expect(await stateOf(`${id}/kid`)).toBe('compensating');
    await settle();
    expect(log).toEqual(['release 1', 'undo before']);
    expect(await stateOf(`${id}/kid`)).toBe('cancelled');
    expect(await stateOf(id)).toBe('cancelled');
    expect(await eventTypes(`${id}/kid`)).toEqual(
      expect.arrayContaining(['RunCompleted', 'CancelRequested', 'CompensationStarted', 'RunCancelled']),
    );
  });

  it('an undo on the child node replaces the child own compensation', async () => {
    const id = newId('nodeundo');
    expectOk(await journal.run(db, withNodeUndo.start, { input: {}, id }, caller));
    await settle();
    expectOk(await go(reserving, `${id}/kid`));
    await settle();
    expectOk(await journal.run(db, withNodeUndo.cancel, { runId: id, reason: 'stop' }, caller));
    await settle();
    expect(log).toEqual(['undo node 1']);
    expect(await stateOf(`${id}/kid`)).toBe('completed');
    expect(await stateOf(id)).toBe('cancelled');
  });
});

describe('limits', () => {
  it('nesting deeper than 8 is refused', async () => {
    const id = newId('nest');
    expectOk(await journal.run(db, nest.start, { input: {}, id }, caller));
    await settle();
    // `nest.8` has eight ancestors and starts; the leaf under it would have nine.
    const deepest = Array.from({ length: 8 }, (_, level) => `${id}${'/c'.repeat(level + 1)}`).at(-1) ?? id;
    expect(await rowOf(deepest)).toBeDefined();
    expect(await rowOf(`${deepest}/c`)).toBeUndefined();
    expect(await errorOf(deepest, 'c', 'do')).toContain('deeper than 8');
  });
});
