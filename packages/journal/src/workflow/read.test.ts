/**
 * What an operator reads about runs, on PGlite: the page of runs with its cursor and filters, one run with the
 * statuses a worker derives, the counts, the stranded runs and a run's history. Each read is checked against runs a
 * worker really left behind.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { initJournal } from '../journal.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const noRetry = backoff.constant(0).upTo(0);
const Nothing = z.object({});

/** Waits for two signals, so a run can sit parked and an early second signal stays unconsumed. */
const order = j
  .workflow('test.read.order', { version: 1, input: z.object({}) })
  .waitFor('first', { signal: 'first', schema: Nothing })
  .waitFor('second', { signal: 'second', schema: Nothing })
  .finish();
const audit = j
  .workflow('test.read.audit', { version: 1, input: z.object({}) })
  .step('log', () => 'logged')
  .finish();
const cart = j
  .workflow('test.read.cart', { version: 2, input: z.object({}) })
  .waitFor('checkout', { signal: 'checkout', schema: Nothing })
  .finish();
/** `a` undoes, `b` declares no undo, `c` is dead. */
const mixed = j
  .workflow('test.read.mixed', { version: 1, input: z.object({}) })
  .step('a', () => 'a', { undo: () => 'undone' })
  .step('b', () => 'b')
  .step(
    'c',
    () => {
      throw new Error('c is down');
    },
    { retry: noRetry },
  )
  .finish();
const kid = j
  .workflow('test.read.kid', { version: 1, input: z.object({}) })
  .waitFor('go', { signal: 'go', schema: Nothing })
  .finish();
const parent = j
  .workflow('test.read.parent', { version: 1, input: z.object({}) })
  .child('kid', kid, { input: () => ({}) })
  .finish();

const journal = j.compose({ workflows: [order, audit, cart, mixed, kid, parent], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

async function settle(on = journal, limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await on.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}
const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};
const idsOf = (page: { readonly runs: readonly { readonly id: string }[] }) => page.runs.map(run => run.id).toSorted();
type Startable = { readonly start: typeof order.start };
const startedIds = async (names: readonly { readonly def: Startable; readonly id: string }[]) => {
  for (const { def, id } of names) expectOk(await journal.run(db, def.start, { input: {}, id }, caller));
  await settle();
};

/** A journal setup of its own: its registry only knows what its `compose` was given. */
const fresh = () => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

const refund = (init: ReturnType<typeof fresh>, extra: boolean) => {
  const builder = init.workflow('test.read.refund', { version: 1, input: z.object({}) }).step('charge', () => 'c');
  return (extra ? builder.step('extra', () => 'x') : builder).waitFor('ok', { signal: 'ok', schema: Nothing }).finish();
};
describe('runs', () => {
  it('runs pages with an opaque cursor and filters by state, name, version, parent and stuck', async () => {
    const orders = [newId('order'), newId('order'), newId('order')];
    const done = newId('audit');
    const cartId = newId('cart');
    const stuckId = newId('mixed');
    const parentId = newId('parent');
    await startedIds([
      ...orders.map(id => ({ def: order, id })),
      { def: audit, id: done },
      { def: cart, id: cartId },
      { def: mixed, id: stuckId },
      { def: parent, id: parentId },
    ]);
    // Pages: two, then one. The cursor is the only way on, and the last page has none.
    const first = await journal.workflows.runs(db, { name: 'test.read.order', limit: 2 });
    expect(first.runs).toHaveLength(2);
    expect(first.next).toEqual(expect.any(String));
    const last = await journal.workflows.runs(db, { name: 'test.read.order', limit: 2, after: first.next ?? '' });
    expect(last.next).toBeNull();
    expect([...idsOf(first), ...idsOf(last)].toSorted()).toEqual(orders.toSorted());
    await expect(journal.workflows.runs(db, { after: 'not-a-cursor' })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });

    expect(idsOf(await journal.workflows.runs(db, { state: 'completed', name: 'test.read.audit' }))).toEqual([done]);
    expect(idsOf(await journal.workflows.runs(db, { version: 2 }))).toEqual([cartId]);
    expect(idsOf(await journal.workflows.runs(db, { parentId }))).toEqual([`${parentId}/kid`]);
    expect(idsOf(await journal.workflows.runs(db, { stuck: true }))).toEqual([stuckId]);
    const calm = await journal.workflows.runs(db, { name: 'test.read.order', stuck: false });
    expect(idsOf(calm)).toEqual(orders.toSorted());
    expect(calm.runs.every(run => run.state === 'parked' && !run.stuck && run.stranded === null)).toBe(true);
  });
});

describe('run', () => {
  it('run shows steps with derived running, stuck and residual', async () => {
    const id = newId('detail');
    expectOk(await journal.run(db, mixed.start, { input: {}, id }, caller));
    await settle();
    const stuck = await journal.workflows.run(db, id);
    expect(stuck?.run).toMatchObject({ state: 'running', node: 'c', stuck: true, stranded: null });
    expect(stuck?.steps.map(step => [step.path, step.phase, step.status, step.stuck])).toEqual([
      ['a', 'do', 'done', false],
      ['b', 'do', 'done', false],
      ['c', 'do', 'failed', true],
    ]);
    expect(stuck?.residual).toEqual([]);

    expectOk(await journal.run(db, mixed.cancel, { runId: id, reason: 'stop' }, caller));
    await settle();
    const over = await journal.workflows.run(db, id);
    expect(over?.run).toMatchObject({ state: 'cancelled', stuck: false });
    // `b` declares no undo: its work stays, so it is residual.
    expect(over?.residual).toEqual(['b']);

    // A step is running while its job holds a live lease, and never when only the row is read.
    const live = newId('live');
    expectOk(await journal.run(db, audit.start, { input: {}, id: live }, caller));
    await db
      .update(tables.jobs)
      .set({ leaseUntil: sql`now() + interval '1 hour'` })
      .where(eq(tables.jobs.runId, live));
    const leased = await journal.workflows.run(db, live);
    expect(leased?.steps.map(step => step.status)).toEqual(['running']);
    await db.update(tables.jobs).set({ leaseUntil: null }).where(eq(tables.jobs.runId, live));
    await settle();

    expect(await journal.workflows.run(db, 'nobody')).toBeUndefined();
  });

  it('run shows the children and the signals no wait has taken', async () => {
    const parentId = newId('family');
    const lonely = newId('lonely');
    await startedIds([
      { def: parent, id: parentId },
      { def: order, id: lonely },
    ]);
    expectOk(await journal.run(db, order.signal('second'), { runId: lonely, deliveryId: 'd1', payload: {} }, caller));
    const family = await journal.workflows.run(db, parentId);
    expect(family?.children).toMatchObject([{ id: `${parentId}/kid`, name: 'test.read.kid', state: 'parked' }]);
    const waiting = await journal.workflows.run(db, lonely);
    expect(waiting?.signals).toMatchObject([{ name: 'second', deliveryId: 'd1' }]);
  });
});

describe('counts', () => {
  it('counts groups by name, version and state', async () => {
    const before = await journal.workflows.counts(db);
    const of = (name: string, version: number, state: string) =>
      before.find(row => row.name === name && row.version === version && row.state === state)?.runs ?? 0;
    const id = newId('counted');
    expectOk(await journal.run(db, cart.start, { input: {}, id }, caller));
    await settle();
    const after = await journal.workflows.counts(db);
    expect(after.find(row => row.name === 'test.read.cart' && row.version === 2 && row.state === 'parked')?.runs).toBe(
      of('test.read.cart', 2, 'parked') + 1,
    );
    expect(after.find(row => row.name === 'test.read.audit' && row.state === 'completed')?.runs).toBe(
      of('test.read.audit', 1, 'completed'),
    );
  });
});

describe('history', () => {
  it("history pages the run's events", async () => {
    const id = newId('history');
    expectOk(await journal.run(db, mixed.start, { input: {}, id }, caller));
    await settle();
    const all = await db
      .select({ type: tables.events.type })
      .from(tables.events)
      .where(and(eq(tables.events.kind, 'workflow.run'), eq(tables.events.entityId, id)))
      .orderBy(asc(tables.events.seq));
    expect(all.length).toBeGreaterThan(3);

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await journal.workflows.history(db, id, { limit: 3, ...(after === undefined ? {} : { after }) });
      seen.push(...page.events.map(event => event.type));
      after = page.next ?? undefined;
      pages++;
    } while (after !== undefined);
    expect(seen).toEqual(all.map(event => event.type));
    expect(pages).toBe(Math.ceil(all.length / 3));
    await expect(journal.workflows.history(db, id, { after: '???' })).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
  });
});

describe('stranded', () => {
  let own: PgliteDatabase;
  let ownClient: PGlite;
  beforeEach(async () => {
    ({ db: own, client: ownClient } = await openJournalDb(tables));
  });
  afterEach(() => ownClient.close());

  it('stranded lists runs whose code is gone or changed', async () => {
    const original = fresh();
    const v1 = refund(original, false);
    const withCode = original.compose({ workflows: [v1], workflowMeta });
    expectOk(await withCode.run(own, v1.start, { input: {}, id: 'gone_1' }, caller));
    expectOk(await withCode.run(own, v1.start, { input: {}, id: 'gone_2' }, caller));
    for (let pass = 0; pass < 10 && (await withCode.drain(own).then(result => orThrow(result))) > 0; pass++);
    expect(await withCode.workflows.stranded(own)).toEqual([]);

    const edited = fresh();
    const changed = edited.compose({ workflows: [refund(edited, true)], workflowMeta });
    const changedRuns = await changed.workflows.stranded(own);
    expect(changedRuns.map(run => [run.id, run.code])).toEqual([
      ['gone_1', 'WORKFLOW_SHAPE_CHANGED'],
      ['gone_2', 'WORKFLOW_SHAPE_CHANGED'],
    ]);

    const empty = fresh();
    const none = empty.compose({
      workflows: [
        empty
          .workflow('test.read.other', { version: 1, input: Nothing })
          .step('s', () => 1)
          .finish(),
      ],
      workflowMeta,
    });
    const firstStranded = await none.workflows.stranded(own, { limit: 1 });
    expect(firstStranded.map(run => [run.id, run.code])).toEqual([['gone_1', 'WORKFLOW_UNKNOWN']]);
    // A finished run is never stranded: its code is not needed any more.
    expectOk(await withCode.run(own, v1.signal('ok'), { runId: 'gone_1', deliveryId: 'd', payload: {} }, caller));
    for (let pass = 0; pass < 10 && (await withCode.drain(own).then(result => orThrow(result))) > 0; pass++);
    const stillStranded = await none.workflows.stranded(own);
    expect(stillStranded.map(run => run.id)).toEqual(['gone_2']);
  });
});
