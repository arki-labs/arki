/**
 * When a run starts and when it gives up waiting, on PGlite: `delay` and `ttl` on `def.start`, and the operator verb
 * `journal.workflows.reschedule`. A delayed run must not do its work early, a run nobody got to in time must end
 * `expired` without doing it (and free its concurrency slot), and a run that has started must never expire, because
 * its first step may already have acted on the world.
 *
 * Time is the one thing these tests fake: instead of sleeping, they move a stored `ttl_at` into the past with an
 * UPDATE, as if the queue had been slow.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import type { RunTiming } from './run-fields.js';
import { CommandConflict, CommandNotFound, WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const operator = { actor: 'usr_ops', reason: 'the customer asked for later', executionId: 'exe_1' };
const HOUR = 3_600_000;

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** How many times each body ran: a run that must not do its work must leave these alone. */
const calls = { send: 0, sync: 0, first: 0, second: 0 };

/** A reminder sent later: `delay` holds its one step back. It has a deadline, which counts from the start. */
const reminder = j
  .workflow('test.timing-reminder', { version: 1, input: z.object({ to: z.string() }), deadline: '1h' })
  .step('send', ({ input }) => {
    calls.send += 1;
    return input.to;
  })
  .finish();

/** One sync per account, kept 3 days when it expires: an expired run must free the slot and use that retention. */
const sync = j
  .workflow('test.timing-sync', {
    version: 1,
    input: z.object({ account: z.string() }),
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'refuse' },
    retention: { expired: '3d' },
  })
  .step('pull', () => {
    calls.sync += 1;
    return 'pulled';
  })
  .finish();

/** Does its first step, then waits for a go before its second: a run that is past its first node. */
const twoPart = j
  .workflow('test.timing-two-part', { version: 1, input: z.object({}) })
  .step('first', () => {
    calls.first += 1;
    return 1;
  })
  .waitFor('go', { signal: 'test.timing.go', schema: z.object({}) })
  .step('second', () => {
    calls.second += 1;
    return 2;
  })
  .finish();

const journal = j.compose({ workflows: [reminder, sync, twoPart], workflowMeta });

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

/** Runs every due job until none is left, as a worker would. */
async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
/** Moves a run's `ttl_at` a minute into the past by the database clock: the faked time. */
const passTtl = (id: string) =>
  db
    .update(tables.workflowRuns)
    .set({ ttlAt: sql`now() - interval '1 minute'` })
    .where(eq(tables.workflowRuns.id, id));
/** One run in full; a test that reads a run it started must find it. */
const detailOf = async (id: string) => {
  const detail = await journal.workflows.run(db, id);
  if (detail === undefined) throw new Error(`no run ${id}`);
  return detail;
};
const eventsOf = async (id: string) => orThrow(await journal.workflows.history(db, id)).events;

describe('delay', () => {
  it('a delayed run does not run its first step before its time, and runs it once rescheduled to now', async () => {
    const id = newId('remind');
    const before = calls.send;
    orThrow(await journal.run(db, reminder.start, { input: { to: 'ann' }, id, delay: '1h' }, caller));
    await settle();
    expect(calls.send).toBe(before);
    const waiting = await detailOf(id);
    expect(waiting.run.state).toBe('running');
    expect(waiting.run.delayedUntil).toEqual(waiting.run.startAt);
    expect(waiting.run.delayedUntil?.getTime()).toBeGreaterThan(Date.now() + HOUR - 60_000);
    const listed = orThrow(await journal.workflows.runs(db, { name: 'test.timing-reminder' }));
    expect(listed.runs.find(run => run.id === id)?.delayedUntil).toEqual(waiting.run.startAt);

    const moved = await journal.workflows.reschedule(db, { runId: id, delay: 0 }, operator);
    expect(isFailure(moved)).toBe(false);
    await settle();
    expect(calls.send).toBe(before + 1);
    const done = await detailOf(id);
    expect(done.run).toMatchObject({ state: 'completed', output: 'ann', delayedUntil: null });
  });

  it('the deadline and the ttl count from the planned start, so a long delay never eats them', async () => {
    const id = newId('remind');
    orThrow(await journal.run(db, reminder.start, { input: { to: 'bo' }, id, delay: '2h', ttl: '30m' }, caller));
    const row = await rowOf(id);
    const startAt = row?.startAt?.getTime() ?? 0;
    expect(row?.deadlineAt?.getTime()).toBe(startAt + HOUR);
    expect(row?.ttlAt?.getTime()).toBe(startAt + HOUR / 2);
    expect(row?.ttlMs).toBe(HOUR / 2);
  });

  it('a time in the past is now: the run is not delayed and runs on the next drain', async () => {
    const id = newId('remind');
    const before = calls.send;
    orThrow(await journal.run(db, reminder.start, { input: { to: 'cy' }, id, delay: new Date(0) }, caller));
    expect(await rowOf(id)).toMatchObject({ startAt: null });
    await settle();
    expect(calls.send).toBe(before + 1);
  });

  it('a bad delay or ttl is refused by the start schema and creates no run', async () => {
    const startWith = async (timing: RunTiming) => {
      const id = newId('remind');
      const refused = await journal.run(db, reminder.start, { input: { to: 'x' }, id, ...timing }, caller);
      expect(InvalidInput.is(refused)).toBe(true);
      expect(await rowOf(id)).toBeUndefined();
    };
    for (const timing of [{ delay: -1 }, { ttl: 0 }, { ttl: '0m' as const }, { delay: new Date(Number.NaN) }]) {
      await startWith(timing);
    }
    // @ts-expect-error a unit outside m, h and d; the type refuses it, and so does the schema for untyped callers
    await startWith({ delay: '5s' });
  });
});

describe('reschedule', () => {
  it('moves the start, the ttl and the deadline together, and records the operator on the event', async () => {
    const id = newId('remind');
    orThrow(await journal.run(db, reminder.start, { input: { to: 'di' }, id, delay: '1h', ttl: '1h' }, caller));
    const at = new Date(Date.now() + 5 * HOUR);
    expect(await journal.workflows.reschedule(db, { runId: id, at }, operator)).toEqual({ startAt: at.toISOString() });
    expect(await rowOf(id)).toMatchObject({
      startAt: at,
      ttlAt: new Date(at.getTime() + HOUR),
      deadlineAt: new Date(at.getTime() + HOUR),
    });
    const [job] = await db
      .select({ availableAt: tables.jobs.availableAt })
      .from(tables.jobs)
      .where(sql`${tables.jobs.runId} = ${id} and ${tables.jobs.effect} = 'workflow.step'`);
    expect(job?.availableAt).toEqual(at);
    const history = await eventsOf(id);
    const rescheduled = history.find(event => event.type === 'RunRescheduled');
    expect(rescheduled?.data).toMatchObject({
      startAt: at.toISOString(),
      actorId: 'usr_ops',
      reason: 'the customer asked for later',
      executionId: 'exe_1',
    });
  });

  it('refuses a run that has started, because its first step may already have acted', async () => {
    const id = newId('remind');
    orThrow(await journal.run(db, reminder.start, { input: { to: 'ed' }, id }, caller));
    await settle();
    const refused = await journal.workflows.reschedule(db, { runId: id, delay: '1h' }, operator);
    expect(CommandConflict.is(refused)).toBe(true);
    const history = await eventsOf(id);
    expect(history.some(event => event.type === 'RunRescheduled')).toBe(false);
  });

  it('refuses a run that does not exist', async () => {
    const refused = await journal.workflows.reschedule(db, { runId: newId('none'), delay: '1h' }, operator);
    expect(CommandNotFound.is(refused)).toBe(true);
  });
});

describe('ttl', () => {
  it('a run claimed after its ttl ends expired without running its body, frees its slot and keeps its own retention', async () => {
    const account = newId('acc');
    const id = newId('sync');
    const before = calls.sync;
    orThrow(await journal.run(db, sync.start, { input: { account }, id, ttl: '1h' }, caller));
    // The slot is held while the run waits to start.
    expect(WorkflowBusy.is(await journal.run(db, sync.start, { input: { account } }, caller))).toBe(true);
    await passTtl(id);
    await settle();
    expect(calls.sync).toBe(before);
    const row = await rowOf(id);
    expect(row?.state).toBe('expired');
    expect(row?.finishedAt).not.toBeNull();
    // The keep time is worked out a moment after the end time, so compare whole hours.
    expect(Math.round(((row?.keepUntil?.getTime() ?? 0) - (row?.finishedAt?.getTime() ?? 0)) / HOUR)).toBe(3 * 24);
    const detail = await detailOf(id);
    expect(detail.steps).toMatchObject([{ path: 'pull', status: 'skipped' }]);
    expect(detail.run.results).toEqual({});
    // The slot is free: the next sync of the account starts.
    expect(isFailure(await journal.run(db, sync.start, { input: { account } }, caller))).toBe(false);
    await settle();
  });

  it('a run claimed before its ttl runs as usual', async () => {
    const id = newId('sync');
    const before = calls.sync;
    orThrow(await journal.run(db, sync.start, { input: { account: newId('acc') }, id, ttl: '1h' }, caller));
    await settle();
    expect(calls.sync).toBe(before + 1);
    expect(await rowOf(id)).toMatchObject({ state: 'completed' });
  });

  it('a run that has started never expires, even past its ttl', async () => {
    const id = newId('two');
    const before = { first: calls.first, second: calls.second };
    orThrow(await journal.run(db, twoPart.start, { input: {}, id, ttl: '1h' }, caller));
    await settle();
    expect(await rowOf(id)).toMatchObject({ state: 'parked', node: 'go' });
    await passTtl(id);
    orThrow(
      await journal.run(db, twoPart.signal('test.timing.go'), { runId: id, deliveryId: 'go_1', payload: {} }, caller),
    );
    await settle();
    expect(calls).toMatchObject({ first: before.first + 1, second: before.second + 1 });
    expect(await rowOf(id)).toMatchObject({ state: 'completed' });
    // Nor can a started run be moved.
    expect(CommandConflict.is(await journal.workflows.reschedule(db, { runId: id, delay: 0 }, operator))).toBe(true);
  });
});
