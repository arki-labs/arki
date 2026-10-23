/**
 * Per-run overrides on PGlite: `maxAttempts`, `timeout` and `priority` on `def.start`, on `startBatch` items and on
 * `journal.workflows.replay`. A run asks for them once and keeps them for its whole life. A step's retry and timeout
 * are code, so a run can only narrow them: a caller that asks for more tries or more time must not get them. A child
 * runs as its own definition says.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Deadline } from '@arki/async';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { STEP_EFFECT, TIMER_EFFECT } from './runner.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const operator = { actor: 'usr_ops', reason: 'rerun after the fix' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** Body calls per run id: how many tries a step got. */
const tries = new Map<string, number>();
/** The run ids in the order their first step ran. */
const ran: string[] = [];

/** A step that always throws, with a retry of 8 tries and no wait. Its dead step compensates, so the run fails. */
const flaky = j
  .workflow('test.overrides-flaky', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step(
    'call',
    ({ runId }) => {
      tries.set(runId, (tries.get(runId) ?? 0) + 1);
      throw new Error('the service is down');
    },
    { retry: backoff.constant(0).upTo(7) },
  )
  .finish();

/** Sleeps 150 ms unless its signal aborts first. `own` has a 50 ms timeout of its own, `free` none. */
const sleep = ({ signal }: { readonly signal: AbortSignal }) =>
  new Promise<string>(resolve => {
    const timer = setTimeout(() => resolve('slept'), 150);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve('aborted');
    });
  });
const noRetry = backoff.constant(0).upTo(0);
const free = j
  .workflow('test.overrides-free', { version: 1, input: z.object({}) })
  .step('nap', sleep, { retry: noRetry })
  .finish();
const own = j
  .workflow('test.overrides-own', { version: 1, input: z.object({}) })
  .step('nap', sleep, { retry: noRetry, timeout: 0.05 })
  .finish();

/** One quick step with a deadline, so a run has a step job and a timer job. */
const quick = j
  .workflow('test.overrides-quick', { version: 1, input: z.object({}), deadline: '1h' })
  .step('go', ({ runId }) => {
    ran.push(runId);
    return 'done';
  })
  .finish();

/** A parent that starts `quick` as its child. */
const parent = j
  .workflow('test.overrides-parent', { version: 1, input: z.object({}) })
  .child('kid', quick, { input: () => ({}) })
  .finish();

const journal = j.compose({ workflows: [flaky, free, own, quick, parent], workflowMeta });

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

/** Runs every due job until none is left, as a worker would. */
async function settle(limit = 60) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  if (row === undefined) throw new Error(`no run ${id}`);
  return row;
};
const stepOf = async (id: string, path: string) => {
  const [step] = await db
    .select()
    .from(tables.workflowSteps)
    .where(and(eq(tables.workflowSteps.runId, id), eq(tables.workflowSteps.path, path)));
  return step;
};
/** What these tests read from a `NodeScheduled` event of a run's history. */
const scheduledSchema = z.object({ phase: z.string(), attempt: z.int(), priority: z.int().optional() });
/** The effect and priority of each job a run's events made, before a worker takes them. */
const jobsOf = (id: string) =>
  db
    .select({ effect: tables.jobs.effect, priority: tables.jobs.priority })
    .from(tables.jobs)
    .innerJoin(tables.events, eq(tables.jobs.eventSeq, tables.events.seq))
    .where(eq(tables.events.entityId, id))
    .orderBy(tables.jobs.effect);

describe('maxAttempts', () => {
  it('stops a step that keeps throwing after the run allows, though its own retry gives 8 tries, and the run follows onDeadStep', async () => {
    const id = newId('flaky');
    orThrow(await journal.run(db, flaky.start, { input: {}, id, maxAttempts: 2 }, caller));
    await settle();
    // Why: a caller who knows the service is down must not pay for 8 tries.
    expect(tries.get(id)).toBe(2);
    expect(await rowOf(id)).toMatchObject({ state: 'failed', maxAttempts: 2 });
  });

  it("a retry keeps the run's priority: the retry's job is queued like the first try's", async () => {
    const id = newId('flaky');
    orThrow(await journal.run(db, flaky.start, { input: {}, id, maxAttempts: 2, priority: 3 }, caller));
    await settle();
    const { events } = orThrow(await journal.workflows.history(db, id));
    const scheduled = events
      .filter(event => event.type === 'NodeScheduled')
      .map(event => scheduledSchema.parse(event.data))
      .filter(data => data.phase === 'do');
    expect(scheduled.map(data => [data.attempt, data.priority])).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it('cannot give a step more tries than its own retry: the run only narrows it', async () => {
    const id = newId('flaky');
    orThrow(await journal.run(db, flaky.start, { input: {}, id, maxAttempts: 20 }, caller));
    await settle();
    expect(tries.get(id)).toBe(8);
  });
});

describe('timeout', () => {
  it('times out a step attempt after the run timeout, though the step has no timeout of its own', async () => {
    const id = newId('free');
    orThrow(await journal.run(db, free.start, { input: {}, id, timeout: 0.05 }, caller));
    await settle();
    const step = await stepOf(id, 'nap');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain(Deadline.code);
    const row = await rowOf(id);
    expect(row.stepTimeoutMs).toBe(50);
  });

  it("a run timeout longer than the step's own does not loosen it", async () => {
    const id = newId('own');
    orThrow(await journal.run(db, own.start, { input: {}, id, timeout: 10 }, caller));
    await settle();
    const step = await stepOf(id, 'nap');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain(Deadline.code);
  });

  it('a step with no timeout anywhere runs to its end', async () => {
    const id = newId('free');
    orThrow(await journal.run(db, free.start, { input: {}, id }, caller));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: 'slept', stepTimeoutMs: null });
  });
});

describe('priority', () => {
  it("puts the run's priority on its step and timer jobs, and a due run with a higher priority is claimed first", async () => {
    const low = newId('quick');
    const high = newId('quick');
    // The low run starts first, so without priority its job would run first.
    orThrow(await journal.run(db, quick.start, { input: {}, id: low }, caller));
    orThrow(await journal.run(db, quick.start, { input: {}, id: high, priority: 5 }, caller));
    expect(await jobsOf(high)).toEqual([
      { effect: STEP_EFFECT, priority: 5 },
      { effect: TIMER_EFFECT, priority: 5 },
    ]);
    expect(await jobsOf(low)).toEqual([
      { effect: STEP_EFFECT, priority: 0 },
      { effect: TIMER_EFFECT, priority: 0 },
    ]);
    const from = ran.length;
    await settle();
    expect(ran.slice(from)).toEqual([high, low]);
    expect(await rowOf(high)).toMatchObject({ priority: 5 });
    expect(await rowOf(low)).toMatchObject({ priority: null });
  });
});

describe('where overrides come from', () => {
  it('each startBatch item carries its own overrides', async () => {
    const [a, b] = [newId('quick'), newId('quick')];
    orThrow(
      await journal.run(
        db,
        quick.startBatch,
        {
          items: [
            { input: {}, id: a, maxAttempts: 3, timeout: '1m', priority: 2 },
            { input: {}, id: b },
          ],
        },
        caller,
      ),
    );
    expect(await rowOf(a)).toMatchObject({ maxAttempts: 3, stepTimeoutMs: 60_000, priority: 2 });
    expect(await rowOf(b)).toMatchObject({ maxAttempts: null, stepTimeoutMs: null, priority: null });
    await settle();
  });

  it("replay keeps the old run's overrides and replaces those it is given", async () => {
    const old = newId('quick');
    orThrow(
      await journal.run(db, quick.start, { input: {}, id: old, maxAttempts: 3, timeout: 1.5, priority: 2 }, caller),
    );
    await settle();
    const kept = orThrow(await journal.workflows.replay(db, { runId: old }, operator));
    if (!('runId' in kept)) throw new Error('the replay was refused');
    expect(await rowOf(kept.runId)).toMatchObject({ maxAttempts: 3, stepTimeoutMs: 1500, priority: 2 });
    const changed = orThrow(
      await journal.workflows.replay(db, { runId: old, overrides: { maxAttempts: 1, priority: -1 } }, operator),
    );
    if (!('runId' in changed)) throw new Error('the replay was refused');
    expect(await rowOf(changed.runId)).toMatchObject({ maxAttempts: 1, stepTimeoutMs: 1500, priority: -1 });
    await settle();
  });

  it('a child does not inherit its parent overrides', async () => {
    const id = newId('parent');
    orThrow(await journal.run(db, parent.start, { input: {}, id, maxAttempts: 2, timeout: 5, priority: 9 }, caller));
    await settle();
    const [kid] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.parentId, id));
    expect(kid).toMatchObject({ state: 'completed', maxAttempts: null, stepTimeoutMs: null, priority: null });
    expect(await rowOf(id)).toMatchObject({ state: 'completed', maxAttempts: 2, stepTimeoutMs: 5000, priority: 9 });
  });

  it('refuses a bad override with InvalidInput and starts nothing', async () => {
    const bad = [
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
      { maxAttempts: 101 },
      { timeout: 0 },
      { timeout: '0m' },
      { timeout: '30d' },
      { priority: 1.5 },
      { priority: 2 ** 31 },
    ] as const;
    for (const override of bad) {
      const id = newId('quick');
      const refused = await journal.run(db, quick.start, { input: {}, id, ...override }, caller);
      expect(isFailure(refused) && InvalidInput.is(refused), JSON.stringify(override)).toBe(true);
      expect(await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id))).toEqual([]);
    }
  });
});
