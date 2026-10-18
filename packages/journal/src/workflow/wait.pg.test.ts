/**
 * A signal, a timeout and a deadline on one parked run, on real Postgres with two connections: whichever
 * commits first moves the run, and the others find it moved and commit nothing. Needs Docker: starts a
 * `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure } from '@arki/failure';

import { j, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const SIGNAL = 'payment.settled';

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 0;

const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};

/** A promise a test settles by hand, to hold a command at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

const Settled = z.object({ ref: z.string() });

/** Waits an hour for a signal, then fails. */
const timed = j
  .workflow('test.race.timed', { version: 1, input: z.object({}) })
  .waitFor('settled', { signal: SIGNAL, schema: Settled, timeout: '1h', onTimeout: 'fail' })
  // A step after the wait keeps the run unfinished when the signal wins, so a timeout that wrongly acts has something to move.
  .step('book', ({ results }) => results.settled.ref)
  .finish();
/** Waits for a signal with no timeout, but only for an hour of run time. */
const bounded = j
  .workflow('test.race.bounded', { version: 1, input: z.object({}), deadline: '1h' })
  .waitFor('settled', { signal: SIGNAL, schema: Settled })
  .finish();

const journal = j.compose({ workflows: [timed, bounded], workflowMeta });

type Side = 'signal' | 'timer' | 'cancel';
type Hold = { readonly arrived: ReturnType<typeof gate>; readonly release: ReturnType<typeof gate> };
const holds = new Map<Side, Hold>();
const hold = (side: Side): Hold => {
  const made = { arrived: gate(), release: gate() };
  holds.set(side, made);
  return made;
};
const timerInput = z.object({ fired: z.unknown() });
journal.hooks.command.around(async (ctx, next) => {
  const side: Side | undefined = ctx.name.endsWith('.cancel')
    ? 'cancel'
    : ctx.name.startsWith('test.race.')
      ? 'signal'
      : ctx.name === 'workflow.checkpoint' && timerInput.safeParse(ctx.input).success
        ? 'timer'
        : undefined;
  const held = side === undefined ? undefined : holds.get(side);
  if (held !== undefined) {
    holds.delete(side ?? 'signal');
    held.arrived.open();
    await held.release.opened;
  }
  await next();
});

beforeEach(async () => {
  holds.clear();
  await dbA.delete(tables.jobs).where(sql`true`);
});

/** A run parked on its wait, with its timer and deadline already due. */
const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};

async function parkedAndDue(def: typeof timed | typeof bounded) {
  const id = `race_${++next}`;
  expectOk(await journal.run(dbA, def.start, { input: {}, id }, caller));
  await journal.drain(dbA);
  const [row] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  expect(row?.state).toBe('parked');
  const back = sql`interval '2 hours'`;
  await dbA
    .update(tables.jobs)
    .set({ availableAt: sql`${tables.jobs.availableAt} - ${back}` })
    .where(eq(tables.jobs.runId, id));
  await dbA
    .update(tables.workflowRuns)
    .set({
      wakeAt: sql`${tables.workflowRuns.wakeAt} - ${back}`,
      deadlineAt: sql`${tables.workflowRuns.deadlineAt} - ${back}`,
    })
    .where(eq(tables.workflowRuns.id, id));
  return id;
}

const outcomeOf = async (id: string) => {
  const events = await dbA
    .select({ type: tables.events.type, data: tables.events.data })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  const [row] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return {
    state: row?.state,
    types: events.map(event => event.type),
    woken: events.filter(
      event => event.type === 'NodeCompleted' && z.object({ path: z.literal('settled') }).safeParse(event.data).success,
    ).length,
    failed: events.filter(event => event.type === 'RunFailed').length,
  };
};

const signal = (def: typeof timed | typeof bounded, id: string) =>
  journal.run(dbB, def.signal(SIGNAL), { runId: id, deliveryId: `evt_${id}`, payload: { ref: 'p1' } }, caller);

describe('signal, timeout and deadline race on one parked run', () => {
  it('a signal that commits while the timeout is in flight wins, and the timeout commits nothing', async () => {
    const id = await parkedAndDue(timed);
    const timer = hold('timer');
    const fired = journal.drain(dbA);
    await timer.arrived.opened;
    expect(await signal(timed, id)).toEqual({ status: 'woke' });
    timer.release.open();
    await fired;
    await journal.drain(dbA);
    const outcome = await outcomeOf(id);
    expect(outcome).toMatchObject({ state: 'completed', woken: 1, failed: 0 });
    expect(outcome.types).not.toContain('TimerFired');
  }, 30_000);

  it('a timeout that commits first wins, and the late signal is dropped instead of waking a failed run', async () => {
    const id = await parkedAndDue(timed);
    const late = hold('signal');
    const sent = signal(timed, id);
    await late.arrived.opened;
    await journal.drain(dbA);
    expect(await outcomeOf(id)).toMatchObject({ state: 'failed', failed: 1 });
    late.release.open();
    expect(await sent).toEqual({ status: 'finished' });
    expect(await outcomeOf(id)).toMatchObject({ state: 'failed', woken: 0, failed: 1 });
    expect(await dbA.select().from(tables.workflowSignals).where(eq(tables.workflowSignals.runId, id))).toEqual([]);
  }, 30_000);

  it('signal and timeout released at the same moment resolve exactly once, whichever gets the row first', async () => {
    for (let round = 0; round < 6; round++) {
      const id = await parkedAndDue(timed);
      const timer = hold('timer');
      const late = hold('signal');
      const fired = journal.drain(dbA);
      const sent = signal(timed, id);
      await Promise.all([timer.arrived.opened, late.arrived.opened]);
      timer.release.open();
      late.release.open();
      const [, sentResult] = await Promise.all([fired, sent]);
      expectOk(sentResult);
      await journal.drain(dbA);
      const outcome = await outcomeOf(id);
      expect(outcome.woken + outcome.failed, `round ${round}: ${outcome.types.join(',')}`).toBe(1);
      expect(outcome.state).toBe(outcome.failed === 1 ? 'failed' : 'completed');
    }
  }, 60_000);

  it('signal and deadline released at the same moment resolve exactly once, so a signal cannot revive an expired run', async () => {
    for (let round = 0; round < 6; round++) {
      const id = await parkedAndDue(bounded);
      const timer = hold('timer');
      const late = hold('signal');
      const fired = journal.drain(dbA);
      const sent = signal(bounded, id);
      await Promise.all([timer.arrived.opened, late.arrived.opened]);
      timer.release.open();
      late.release.open();
      const [, sentResult] = await Promise.all([fired, sent]);
      expectOk(sentResult);
      const outcome = await outcomeOf(id);
      // The deadline has passed in both orders, so the run fails and the signal never completes the wait.
      expect(outcome, `round ${round}: ${outcome.types.join(',')}`).toMatchObject({
        state: 'failed',
        woken: 0,
        failed: 1,
      });
      expect(outcome.types.filter(type => type === 'DeadlineReached')).toHaveLength(1);
    }
  }, 60_000);
});

describe('cancel races a signal and a timeout on one parked run', () => {
  it('signal, timeout and cancel on one parked run resolve exactly once', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await parkedAndDue(timed);
      const timer = hold('timer');
      const late = hold('signal');
      const stop = hold('cancel');
      const fired = journal.drain(dbA);
      const sent = signal(timed, id);
      const cancelled = journal.run(dbA, timed.cancel, { runId: id, reason: 'race' }, caller);
      await Promise.all([timer.arrived.opened, late.arrived.opened, stop.arrived.opened]);
      timer.release.open();
      late.release.open();
      stop.release.open();
      const [, sentResult, cancelResult] = await Promise.all([fired, sent, cancelled]);
      expectOk(sentResult);
      await journal.drain(dbA);
      const events = await dbA
        .select({ type: tables.events.type, data: tables.events.data })
        .from(tables.events)
        .where(eq(tables.events.entityId, id))
        .orderBy(asc(tables.events.seq));
      const settledNode = events.filter(
        event =>
          ['NodeCompleted', 'NodeFailed', 'NodeSkipped'].includes(event.type) &&
          z.object({ path: z.literal('settled') }).safeParse(event.data).success,
      );
      const ended = events.filter(event => ['RunCompleted', 'RunFailed', 'RunCancelled'].includes(event.type));
      const label = `round ${round}: ${events.map(event => event.type).join(',')}`;
      // The wait ends once, whoever got the row, and the run ends once.
      expect(settledNode, label).toHaveLength(1);
      expect(ended, label).toHaveLength(1);
      expect(events.filter(event => event.type === 'CompensationStarted').length, label).toBeLessThanOrEqual(1);
      // A cancel that lost to the end of the wait is a returned conflict, never a second end.
      if (events.some(event => event.type === 'CancelRequested')) expect(isFailure(cancelResult), label).toBe(false);
      else expect(isFailure(cancelResult), label).toBe(true);
    }
  }, 90_000);
});
