/**
 * `onBusy: 'queue'` on PGlite. A queue is what lets an app say "run every import, one per account at a time" without
 * the caller retrying: a busy start must create the run and keep it waiting with no work done, a queued run must hold
 * no slot, and the oldest queued run that fits must start as soon as a slot frees, in the same transaction. Races
 * between two real connections are in `runner.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const ops = { actor: 'usr_ops', reason: 'incident 42' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** The runs whose `work` body ran, by run id: a queued run must never get here before it is promoted. */
const worked: string[] = [];

const accountInput = z.object({ account: z.string(), fail: z.boolean().optional() });
const byAccount = ({ account }: { account: string }) => account;
type Concurrency = NonNullable<Parameters<typeof j.workflow<typeof accountInput>>[1]['concurrency']>;

/**
 * A run that parks until it is told to go, so it holds its slot for as long as a test needs, then does its work. Its
 * work throws when the input says `fail`, and the run then compensates and ends `failed`.
 */
const held = (name: string, concurrency: Concurrency) =>
  j
    .workflow(name, { version: 1, input: accountInput, concurrency, onDeadStep: 'compensate' })
    .waitFor('go', { signal: 'go', schema: z.object({}) })
    .step(
      'work',
      ({ input, runId }) => {
        worked.push(runId);
        if (input.fail === true) throw new Error('the work failed');
        return input.account;
      },
      { retry: backoff.constant(0).upTo(0) },
    )
    .finish();

/** One run per account; the others wait their turn. */
const keyed = held('test.q.keyed', { key: byAccount, limit: 1, onBusy: 'queue' });
/** One run in all, whatever the account: an operator raises it. */
const pool = held('test.q.pool', { total: 1, onBusy: 'queue' });
/** One run at a time across two workflows. */
const slot = j.limit({ name: 'test.q.slot', total: 1 });
const slotA = held('test.q.slot-a', { shared: [slot], onBusy: 'queue' });
const slotB = held('test.q.slot-b', { shared: [slot], onBusy: 'queue' });
/** The same key, refused: the scope rules of `refuse` stay as they were. */
const refused = held('test.q.refused', { key: byAccount, limit: 1, onBusy: 'refuse' });
/** A run whose first node is its work: a queued one must expire with its body never called. */
const quick = j
  .workflow('test.q.quick', {
    version: 1,
    input: accountInput,
    concurrency: { key: byAccount, limit: 1, onBusy: 'queue' },
  })
  .step('work', ({ input, runId }) => {
    worked.push(runId);
    return input.account;
  })
  .finish();
/** A child that queues on its account, and the parent that waits for it. */
const child = held('test.q.child', { key: byAccount, limit: 1, onBusy: 'queue' });
const parent = j
  .workflow('test.q.parent', { version: 1, input: accountInput })
  .child('kid', child, { input: ({ input }) => ({ account: input.account }) })
  .finish();

const journal = j.compose({
  workflows: [keyed, pool, slotA, slotB, refused, quick, child, parent],
  workflowMeta,
});

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

type Def = typeof keyed;
const start = async (
  def: { readonly start: Def['start'] },
  account: string,
  extra: { readonly fail?: boolean; readonly scope?: string; readonly ttl?: '1h'; readonly delay?: '1h' } = {},
) => {
  const { fail, ...rest } = extra;
  const input = fail === undefined ? { account } : { account, fail };
  return orThrow(await journal.run(db, def.start, { input, ...rest }, caller)).runId;
};
const go = async (def: Def, runId: string) => {
  orThrow(await journal.run(db, def.signal('go'), { runId, deliveryId: `go:${runId}`, payload: {} }, caller));
  await settle();
};
const stateOf = async (runId: string) => {
  const [row] = await db
    .select({ state: tables.workflowRuns.state })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, runId));
  return row?.state;
};
const typesOf = async (runId: string) =>
  orThrow(await journal.workflows.history(db, runId)).events.map(event => event.type);
/** The jobs of a run that are still waiting to run: a queued run has none but its ttl timer. */
const pendingJobs = (runId: string) =>
  db
    .select({ effect: tables.jobs.effect, availableAt: tables.jobs.availableAt })
    .from(tables.jobs)
    .where(and(eq(tables.jobs.runId, runId), isNull(tables.jobs.deadAt)));

describe('a busy start queues', () => {
  it('creates the run queued with no node, and the oldest starts when the holder completes, then the next', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account);
    await settle();
    const first = await start(keyed, account);
    const second = await start(keyed, account);
    await settle();
    expect(await stateOf(first)).toBe('queued');
    // Nothing is scheduled: the worker has no job for a queued run, so its work cannot start early.
    expect(await typesOf(first)).toEqual(['RunStarted', 'RunQueued']);
    expect(await pendingJobs(first)).toEqual([]);

    await go(keyed, holder);
    expect(await stateOf(holder)).toBe('completed');
    // The holder's end promoted the oldest, in its own transaction: it parks on its wait, the next stays queued.
    expect(await stateOf(first)).toBe('parked');
    expect(await stateOf(second)).toBe('queued');
    expect(await typesOf(first)).toEqual(['RunStarted', 'RunQueued', 'RunDequeued', 'NodeScheduled', 'Parked']);

    await go(keyed, first);
    expect(await stateOf(second)).toBe('parked');
    await go(keyed, second);
    expect(await stateOf(second)).toBe('completed');
  });

  it('a queued run holds no slot: one running and two queued count one, and the limit shows both numbers', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account);
    await start(keyed, account);
    await start(keyed, account);
    await settle();
    const [running] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tables.workflowRuns)
      .where(
        and(
          eq(tables.workflowRuns.concurrencyKey, account),
          isNull(tables.workflowRuns.finishedAt),
          sql`${tables.workflowRuns.state} <> 'queued'`,
        ),
      );
    expect(running?.n).toBe(1);
    const view = orThrow(await journal.limits.get(db, 'workflow/test.q.keyed'));
    expect(view).toMatchObject({ running: 1, queued: 2 });
    // Release the key for the next tests: each end promotes the next.
    await go(keyed, holder);
    for (const { id } of await db
      .select({ id: tables.workflowRuns.id })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.concurrencyKey, account))) {
      if ((await stateOf(id)) === 'parked') await go(keyed, id);
    }
  });

  it('a queue on one key does not hold back another key', async () => {
    const busy = newId('acc');
    const holder = await start(keyed, busy);
    const waiting = await start(keyed, busy);
    const other = await start(keyed, newId('acc'));
    await settle();
    expect(await stateOf(waiting)).toBe('queued');
    expect(await stateOf(other)).toBe('parked');
    await go(keyed, other);
    await go(keyed, holder);
    await go(keyed, waiting);
  });
});

describe('every way a holder ends frees its slot', () => {
  it('a holder that fails promotes the queued run', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account, { fail: true });
    await settle();
    const waiting = await start(keyed, account);
    await go(keyed, holder);
    expect(await stateOf(holder)).toBe('failed');
    expect(await stateOf(waiting)).toBe('parked');
    await go(keyed, waiting);
  });

  it('a holder that is cancelled promotes the queued run', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account);
    await settle();
    const waiting = await start(keyed, account);
    orThrow(await journal.run(db, keyed.cancel, { runId: holder, reason: 'not needed' }, caller));
    expect(await stateOf(holder)).toBe('cancelled');
    expect(await stateOf(waiting)).toBe('running');
    await settle();
    expect(await stateOf(waiting)).toBe('parked');
    await go(keyed, waiting);
  });

  it('a holder that expires before it started promotes the queued run', async () => {
    const account = newId('acc');
    // Not drained: the holder is running, its first node not started, and it holds the slot.
    const holder = await start(keyed, account, { ttl: '1h' });
    const waiting = await start(keyed, account);
    expect(await stateOf(waiting)).toBe('queued');
    await db
      .update(tables.workflowRuns)
      .set({ ttlAt: sql`now() - interval '1 minute'` })
      .where(eq(tables.workflowRuns.id, holder));
    await settle();
    expect(await stateOf(holder)).toBe('expired');
    expect(await stateOf(waiting)).toBe('parked');
    await go(keyed, waiting);
  });
});

describe('a queued run on its own', () => {
  it('a queued run past its ttl ends expired without its body ever running, and frees nothing', async () => {
    const account = newId('acc');
    const holder = await start(quick, account);
    const waiting = await start(quick, account, { ttl: '1h' });
    expect(await stateOf(waiting)).toBe('queued');
    // Its ttl timer is its one job.
    const jobs = await pendingJobs(waiting);
    expect(jobs.map(job => job.effect)).toEqual(['workflow.timer']);
    await db
      .update(tables.workflowRuns)
      .set({ ttlAt: sql`now() - interval '1 minute'` })
      .where(eq(tables.workflowRuns.id, waiting));
    await db
      .update(tables.jobs)
      .set({ availableAt: sql`now() - interval '1 minute'` })
      .where(eq(tables.jobs.runId, waiting));
    await settle();
    expect(await stateOf(holder)).toBe('completed');
    expect(await stateOf(waiting)).toBe('expired');
    expect(worked.filter(id => id === waiting)).toEqual([]);
    expect(await typesOf(waiting)).toEqual(['RunStarted', 'RunQueued', 'RunExpired']);
  });

  it('a cancel ends a queued run cancelled at once, with nothing to undo and its ttl timer gone', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account);
    const waiting = await start(keyed, account, { ttl: '1h' });
    const outcome = orThrow(await journal.run(db, keyed.cancel, { runId: waiting, reason: 'not needed' }, caller));
    expect(outcome).toEqual({ state: 'cancelled' });
    expect(await typesOf(waiting)).toEqual(['RunStarted', 'RunQueued', 'CancelRequested', 'RunCancelled']);
    expect(await pendingJobs(waiting)).toEqual([]);
    // The holder keeps its slot: the cancelled run never had one.
    expect(orThrow(await journal.limits.get(db, 'workflow/test.q.keyed'))).toMatchObject({ queued: 0 });
    await settle();
    await go(keyed, holder);
  });

  it('a delayed queued run, once promoted, has its first node due at its start time, not now', async () => {
    const account = newId('acc');
    const holder = await start(quick, account);
    const waiting = await start(quick, account, { delay: '1h' });
    const [row] = await db
      .select({ startAt: tables.workflowRuns.startAt })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.id, waiting));
    await settle();
    expect(await stateOf(holder)).toBe('completed');
    expect(await stateOf(waiting)).toBe('running');
    const jobs = await pendingJobs(waiting);
    expect(jobs.map(job => job.effect)).toEqual(['workflow.step']);
    expect(jobs[0]?.availableAt.getTime()).toBe(row?.startAt?.getTime());
    expect(worked.filter(id => id === waiting)).toEqual([]);
    orThrow(await journal.workflows.reschedule(db, { runId: waiting, delay: 0 }, ops));
    await settle();
    expect(await stateOf(waiting)).toBe('completed');
  });

  it('reschedule moves a queued run and its ttl timer, and writes no node', async () => {
    const account = newId('acc');
    const holder = await start(keyed, account);
    const waiting = await start(keyed, account, { ttl: '1h' });
    const at = new Date(Date.now() + 2 * 3_600_000);
    expect(await journal.workflows.reschedule(db, { runId: waiting, at }, ops)).toEqual({ startAt: at.toISOString() });
    expect(await stateOf(waiting)).toBe('queued');
    const [timer] = await pendingJobs(waiting);
    expect(timer?.availableAt.getTime()).toBe(at.getTime() + 3_600_000);
    orThrow(await journal.run(db, keyed.cancel, { runId: waiting, reason: 'done' }, caller));
    await settle();
    await go(keyed, holder);
  });

  it('a queued child keeps its parent parked, and the parent goes on once the child is promoted and ends', async () => {
    const account = newId('acc');
    const holder = await start(child, account);
    const top = await start(parent, account);
    await settle();
    expect(await stateOf(top)).toBe('parked');
    const [kid] = await db
      .select({ id: tables.workflowRuns.id, state: tables.workflowRuns.state })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.parentId, top));
    expect(kid?.state).toBe('queued');
    await go(child, holder);
    expect(await stateOf(kid?.id ?? '')).toBe('parked');
    expect(await stateOf(top)).toBe('parked');
    await go(child, kid?.id ?? '');
    expect(await stateOf(top)).toBe('completed');
  });

  it('a queued start never crosses its scope: it gets its own new run, and refuse still names only its own runs', async () => {
    const account = newId('acc');
    const theirs = await start(keyed, account, { scope: 'tenant_a' });
    const mine = await start(keyed, account, { scope: 'tenant_b' });
    expect(mine).not.toBe(theirs);
    expect(await stateOf(mine)).toBe('queued');
    await start(refused, account, { scope: 'tenant_a' });
    const busy = await journal.run(db, refused.start, { input: { account }, scope: 'tenant_b' }, caller);
    expect(isFailure(busy) && 'data' in busy ? busy.data : undefined).toMatchObject({ running: [] });
    await settle();
    await go(keyed, theirs);
    await go(keyed, mine);
    const [refusedRun] = await db
      .select({ id: tables.workflowRuns.id })
      .from(tables.workflowRuns)
      .where(and(eq(tables.workflowRuns.name, 'test.q.refused'), eq(tables.workflowRuns.concurrencyKey, account)));
    await go(refused, refusedRun?.id ?? '');
  });
});

describe('limits that free room', () => {
  it('a shared limit queues the runs of two workflows and promotes across them, oldest first', async () => {
    const holder = await start(slotA, newId('acc'));
    const fromB = await start(slotB, newId('acc'));
    const fromA = await start(slotA, newId('acc'));
    await settle();
    expect([await stateOf(fromB), await stateOf(fromA)]).toEqual(['queued', 'queued']);
    await go(slotA, holder);
    expect([await stateOf(fromB), await stateOf(fromA)]).toEqual(['parked', 'queued']);
    await go(slotB, fromB);
    await go(slotA, fromA);
  });

  it('a start on a paused limit queues, and the resume promotes it', async () => {
    orThrow(await journal.limits.pause(db, { name: 'workflow/test.q.keyed' }, ops));
    const waiting = await start(keyed, newId('acc'));
    expect(await typesOf(waiting)).toEqual(['RunStarted', 'RunQueued']);
    const [queued] = orThrow(await journal.workflows.history(db, waiting)).events.slice(1);
    expect(queued?.data).toMatchObject({ limitName: 'workflow/test.q.keyed', reason: 'paused' });
    orThrow(await journal.limits.resume(db, { name: 'workflow/test.q.keyed' }, ops));
    expect(await stateOf(waiting)).toBe('running');
    await settle();
    await go(keyed, waiting);
  });

  it('raising a total promotes up to the new room, oldest first, and no more', async () => {
    const holder = await start(pool, newId('acc'));
    const waiting = [await start(pool, newId('acc')), await start(pool, newId('acc')), await start(pool, newId('acc'))];
    const raised = orThrow(await journal.limits.override(db, { name: 'workflow/test.q.pool', total: 3 }, ops));
    expect(raised).toMatchObject({ running: 3, queued: 1 });
    expect(await Promise.all(waiting.map(id => stateOf(id)))).toEqual(['running', 'running', 'queued']);
    orThrow(await journal.limits.reset(db, { name: 'workflow/test.q.pool' }, ops));
    await settle();
    const [last] = waiting.slice(2);
    for (const id of [holder, ...waiting.slice(0, 2)]) {
      await go(pool, id);
      // The reset gave back a total of 1: the last one waits until all three that ran are done.
      expect(await stateOf(last ?? '')).toBe(id === waiting[1] ? 'parked' : 'queued');
    }
    await go(pool, last ?? '');
  });

  it('a key override that runs out promotes the run it held back, with no operator step', async () => {
    const account = newId('acc');
    orThrow(
      await journal.limits.override(db, { name: 'workflow/test.q.keyed', key: account, perKey: 0, ttl: '1h' }, ops),
    );
    const waiting = await start(keyed, account);
    expect(await stateOf(waiting)).toBe('queued');
    await settle();
    expect(await stateOf(waiting)).toBe('queued');
    // The override's time passes: its stored end and its timer job move into the past.
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.execute(
      sql`update journal_limits set keys = jsonb_set(keys, ${`{${account},until}`}::text[], to_jsonb(${past}::text)) where name = 'workflow/test.q.keyed'`,
    );
    await db
      .update(tables.jobs)
      .set({ availableAt: sql`now() - interval '1 minute'` })
      .where(and(eq(tables.jobs.effect, 'workflow.limitTimer'), isNull(tables.jobs.deadAt)));
    await settle();
    expect(await stateOf(waiting)).toBe('parked');
    await go(keyed, waiting);
  });
});
