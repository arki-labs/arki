/**
 * `workflowHarness`: a test moves time with `tick`, runs due work with `drain`, and restarts the process with `crash`.
 * A crash keeps the rows and loses the runtime, so these tests prove a run survives a restart the way production needs.
 */
import { readFileSync } from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { initJournal } from './journal.js';
import { tables } from './test-support.js';
import { openJournalDb, workflowHarness, workflowHarnessOn } from './testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const SIGNAL = 'test.harness.confirmed';
const Confirmed = z.object({ by: z.string() });

/** Every step body and undo that ran, in order. */
const log: string[] = [];
/** The keys the fake provider was called with. */
const provider: string[] = [];

/** A promise the test awaits until a step reports that it reached a point. */
const noop = (): void => {
  // Replaced by the promise's resolver before the point is returned.
};
const signalPoint = () => {
  let reach = noop;
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  return { reached, reach: () => reach() };
};
/** The process dies here: nothing after this line of the body ever runs. */
const dieHere = () =>
  new Promise<never>(() => {
    // Never settles.
  });
let charged = signalPoint();
let undoing = signalPoint();
let dieInUndoB = false;

/** The app as a test boots it: a new `initJournal`, its definitions and one compose, again after each crash. */
function setup() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const napping = j
      .workflow('test.harness.napping', { version: 1, input: z.object({}) })
      .step('before', () => void log.push('before'))
      .sleep('nap', '1h')
      .step('after', () => void log.push('after'))
      .finish();

    const bounded = j
      .workflow('test.harness.bounded', { version: 1, input: z.object({}), deadline: '2h' })
      .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
      .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
      .finish();

    const quick = j
      .workflow('test.harness.quick', { version: 1, input: z.object({}) })
      .step('one', () => 1)
      .step('two', () => 2)
      .finish();

    const charging = j
      .workflow('test.harness.charging', { version: 1, input: z.object({}) })
      .step('chargeCard', async ({ key }) => {
        provider.push(key);
        // The provider answered. The first time, the process dies before the checkpoint commits.
        if (provider.length === 1) {
          charged.reach();
          await dieHere();
        }
        return { chargeId: 'ch_1' };
      })
      .finish();

    const three = j
      .workflow('test.harness.three', { version: 1, input: z.object({}) })
      .step('a', () => 'a', { undo: () => void log.push('undo a') })
      .step('b', () => 'b', {
        undo: async ({ key }) => {
          log.push(`undo b ${key}`);
          if (dieInUndoB) {
            dieInUndoB = false;
            undoing.reach();
            await dieHere();
          }
        },
      })
      .step('c', () => 'c', { undo: () => void log.push('undo c') })
      .waitFor('confirm', { signal: SIGNAL, schema: Confirmed })
      .finish();

  const journal = j.compose({ workflows: [napping, bounded, quick, charging, three], workflowMeta });
  return { tables, journal, napping, bounded, quick, charging, three };
}

const h = await workflowHarness({ setup });

/** The commands the first runtime ran. Hooks are runtime: they are registered at boot, before any work. */
const firstRuntimeCommands: string[] = [];
h.journal.hooks.command.around(async (ctx, next) => {
  firstRuntimeCommands.push(ctx.name);
  await next();
});

let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;
const eventTypes = async (id: string) => {
  const rows = await h.db
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return rows.map(row => row.type);
};
const stepRow = async (runId: string, path: string, phase: 'do' | 'undo') => {
  const [row] = await h.db
    .select()
    .from(tables.workflowSteps)
    .where(
      and(
        eq(tables.workflowSteps.runId, runId),
        eq(tables.workflowSteps.path, path),
        eq(tables.workflowSteps.phase, phase),
      ),
    );
  return row;
};

afterAll(() => h.close());

describe('workflowHarness', () => {
  it('tick moves a timer past its wake time so a parked sleep resumes on the next drain', async () => {
    log.length = 0;
    const id = newId('nap');
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id }, caller));
    orThrow(await h.drain());
    expect(orThrow(await h.napping.read(h.db, id))?.run.state).toBe('parked');
    // Without a tick the timer is not due: a drain runs nothing and the run stays parked.
    expect(orThrow(await h.drain())).toBe(0);
    await h.tick('59m');
    expect(orThrow(await h.drain())).toBe(0);
    await h.tick('1m');
    orThrow(await h.drain());
    expect(orThrow(await h.napping.read(h.db, id))?.run.state).toBe('completed');
    expect(log).toEqual(['before', 'after']);
  });

  it('tick past a deadline fails the parked run and compensates', async () => {
    log.length = 0;
    const id = newId('bounded');
    orThrow(await h.journal.run(h.db, h.bounded.start, { input: {}, id }, caller));
    orThrow(await h.drain());
    expect(orThrow(await h.bounded.read(h.db, id))?.run.state).toBe('parked');
    await h.tick('3h');
    orThrow(await h.drain());
    expect(orThrow(await h.bounded.read(h.db, id))?.run.state).toBe('failed');
    expect(log).toEqual(['undo charge']);
    expect(await eventTypes(id)).toContain('DeadlineReached');
  });

  it('drain runs every due job and stops when none is due', async () => {
    // More jobs than one `journal.drain` claims (20), so a single pass would leave runs unfinished.
    const quickIds = Array.from({ length: 12 }, () => newId('quick'));
    const parked = newId('nap');
    for (const id of quickIds) orThrow(await h.journal.run(h.db, h.quick.start, { input: {}, id }, caller));
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id: parked }, caller));
    // One call runs every quick run to the end and returns while the sleep's timer is not due yet.
    expect(orThrow(await h.drain())).toBeGreaterThan(20);
    for (const id of quickIds) expect(orThrow(await h.quick.read(h.db, id))?.run.state).toBe('completed');
    expect(orThrow(await h.napping.read(h.db, parked))?.run.state).toBe('parked');
    expect(orThrow(await h.drain())).toBe(0);
    // Let the parked run finish, so later tests see only their own steps.
    await h.tick('1h');
    orThrow(await h.drain());
    log.length = 0;
  });

  it('crash() keeps the database and loses the runtime', async () => {
    log.length = 0;
    const id = newId('nap');
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id }, caller));
    orThrow(await h.drain());
    expect(firstRuntimeCommands.length).toBeGreaterThan(0);
    const before = { journal: h.journal, napping: h.napping };

    h.crash();
    firstRuntimeCommands.length = 0;
    // The journal and the definitions are new objects, as after a real restart.
    expect(h.journal).not.toBe(before.journal);
    expect(h.napping).not.toBe(before.napping);
    // The run started before the crash finishes on the new runtime, and the old runtime's hook never hears of it.
    await h.tick('1h');
    orThrow(await h.drain());
    expect(orThrow(await h.napping.read(h.db, id))?.run.state).toBe('completed');
    expect(log).toEqual(['before', 'after']);
    expect(firstRuntimeCommands).toEqual([]);
  });

  it('crash after the provider answered and before the checkpoint re-runs the step with the same key', async () => {
    const id = newId('charging');
    charged = signalPoint();
    orThrow(await h.journal.run(h.db, h.charging.start, { input: {}, id }, caller));
    // This drain never returns: the process dies inside the step body, after the provider answered.
    // eslint-disable-next-line failure/must-use -- the drain never settles, so it has no result to handle
    void h.drain();
    await charged.reached;
    expect(await eventTypes(id)).toEqual(['RunStarted', 'NodeScheduled']);

    h.crash();
    // The dead worker's lease must run out before a new worker may take the job.
    await h.tick('2m');
    orThrow(await h.drain());
    expect(provider).toHaveLength(2);
    expect(provider[1]).toBe(provider[0]);
    const read = await h.charging.read(h.db, id);
    if (read === undefined || isFailure(read)) throw new Error('expected the run');
    expect(read.run).toMatchObject({ state: 'completed', results: { chargeCard: { chargeId: 'ch_1' } } });
    const types = await eventTypes(id);
    expect(types.filter(type => type === 'NodeCompleted')).toHaveLength(1);
  });

  it('compensation crash resumes at the undone step, not from the start', async () => {
    log.length = 0;
    const id = newId('three');
    orThrow(await h.journal.run(h.db, h.three.start, { input: {}, id }, caller));
    orThrow(await h.drain());
    expect(orThrow(await h.three.read(h.db, id))?.run.state).toBe('parked');
    orThrow(await h.journal.run(h.db, h.three.cancel, { runId: id, reason: 'changed my mind' }, caller));
    undoing = signalPoint();
    dieInUndoB = true;
    // The process dies inside the undo of `b`, after `c` was undone.
    // eslint-disable-next-line failure/must-use -- the drain never settles, so it has no result to handle
    void h.drain();
    await undoing.reached;

    h.crash();
    await h.tick('2m');
    orThrow(await h.drain());
    // `c` is not undone again; `b` runs again under its key, then `a`.
    const keyOfB = `${id}:b:undo`;
    expect(log).toEqual(['undo c', `undo b ${keyOfB}`, `undo b ${keyOfB}`, 'undo a']);
    expect(await stepRow(id, 'c', 'undo')).toMatchObject({ status: 'done' });
    expect(await stepRow(id, 'b', 'undo')).toMatchObject({ status: 'done' });
    expect(orThrow(await h.three.read(h.db, id))?.run.state).toBe('cancelled');
  });
});

// The published types, not the source: declaration emit once printed the inferred return as `Promise<never>`, so every
// member of a user's harness was `never` and any misuse compiled. `turbo test` builds first, so `dist` is current here;
// `testing.test-d.ts` proves the named type itself is right.
describe('workflowHarness, one job at a time', () => {
  it('dueJobs shows what a worker could claim, and release runs the one picked and no other', async () => {
    log.length = 0;
    const first = newId('nap');
    const second = newId('nap');
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id: first }, caller));
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id: second }, caller));
    const due = await h.dueJobs();
    expect(due.filter(job => job.runId === second)).toEqual([
      expect.objectContaining({ effect: 'workflow.step', type: 'NodeScheduled', runId: second }),
    ]);

    // The later run goes first, though a worker left alone would have claimed the earlier one.
    orThrow(await h.release(job => job.runId === second));
    expect(orThrow(await h.napping.read(h.db, second))?.run.state).toBe('running');
    expect(log).toEqual(['before']);
    expect(orThrow(await h.napping.read(h.db, first))?.run.state).toBe('running');
    // The job it held back is due again, as it was: nothing lost its place.
    const stillDue = await h.dueJobs();
    const stillDueIds = stillDue.map(job => job.id);
    expect(stillDueIds).toContain(due.find(job => job.runId === first)?.id);
    expect(stillDueIds).not.toContain(due.find(job => job.runId === second)?.id);
    orThrow(await h.drain());
    expect(orThrow(await h.napping.read(h.db, first))?.run.state).toBe('parked');
  });

  it('tickTo a time that has passed moves nothing, so a test can never move time back', async () => {
    await expect(h.tickTo(new Date(Date.now() - 60_000))).resolves.toBeUndefined();
  });

  it('release says what was due when nothing fits', async () => {
    await expect(h.release(job => job.effect === 'no.such.effect')).rejects.toThrow(/no due job fits/);
  });

  it('tickTo moves time to a stored moment: one second short leaves the timer waiting', async () => {
    const id = newId('nap');
    orThrow(await h.journal.run(h.db, h.napping.start, { input: {}, id }, caller));
    orThrow(await h.drain());
    const wakeAt = async () => {
      const at = orThrow(await h.napping.read(h.db, id))?.run.wakeAt;
      if (at === null || at === undefined) throw new Error('the run is not parked on a time');
      return at;
    };
    const parkedUntil = await wakeAt();
    await h.tickTo(new Date(parkedUntil.getTime() - 1000));
    expect(orThrow(await h.drain())).toBe(0);
    // `tick` moved the stored time too, so it is read again.
    await h.tickTo(await wakeAt());
    orThrow(await h.drain());
    expect(orThrow(await h.napping.read(h.db, id))?.run.state).toBe('completed');
  });
});

describe('workflowHarnessOn', () => {
  it('runs on the database it is given, and leaves it open', async () => {
    const { db, client } = await openJournalDb(tables);
    const on = workflowHarnessOn(db, { setup });
    orThrow(await on.journal.run(on.db, on.napping.start, { input: {}, id: 'run_on' }, caller));
    orThrow(await on.drain());
    expect(orThrow(await on.napping.read(db, 'run_on'))?.run.state).toBe('parked');
    await on.close();
    // `close` is the test's: the database still answers.
    expect(await db.select().from(tables.workflowRuns)).toHaveLength(1);
    await client.close();
  });
});

describe('workflowHarness, as published', () => {
  it('declares its named return type, not an inferred one', () => {
    const published = readFileSync(new URL('../dist/testing.d.ts', import.meta.url), 'utf8');
    expect(published).toContain('): Promise<WorkflowHarness<S, PgliteDb>>;');
    expect(published).not.toContain('Promise<never>');
  });
});
