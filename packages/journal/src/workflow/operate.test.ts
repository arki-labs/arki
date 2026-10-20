/**
 * The operator verbs on PGlite: `retryStep`, `resolveStep` and `skipUndo` move a run that is stuck, and every event they
 * write says who did it. A dead step is the runner's own state (a failed step row, no dead job), so each verb is checked
 * against the rows and events a worker would leave, not against a mock.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { InvalidInput, isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const operator = { actor: 'usr_ops', reason: 'the provider is back', executionId: 'exe_1' };
const noRetry = backoff.constant(0).upTo(0);
const Shipped = z.object({ tracking: z.string() });

/** What the test makes break, and what ran. */
const broken = { ship: false, undoCharge: false, kid: false };
const log: string[] = [];
const shipKeys: { readonly key: string; readonly attempt: number }[] = [];

/** `ship` fails while `broken.ship` is set, and has an `output` schema, so an operator may give its result. */
const payout = j
  .workflow('test.op.payout', { version: 1, input: z.object({}) })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step(
    'ship',
    ({ key, attempt }) => {
      shipKeys.push({ key, attempt });
      if (broken.ship) throw new Error('carrier down');
      return { tracking: 't1' };
    },
    { retry: noRetry, output: Shipped, undo: () => void log.push('undo ship') },
  )
  .step('notify', ({ results }) => `sent ${results.ship.tracking}`)
  .finish();

/** The same dead step, with no `output` schema: nothing checks what an operator would give. */
const unchecked = j
  .workflow('test.op.unchecked', { version: 1, input: z.object({}) })
  .step(
    'legacy',
    () => {
      throw new Error('legacy down');
    },
    { retry: noRetry },
  )
  .finish();

/** `refund` fails to undo while `broken.undoCharge` is set. */
const refunding = j
  .workflow('test.op.refunding', { version: 1, input: z.object({}) })
  .step('reserve', () => 'reserved', { undo: () => void log.push('undo reserve') })
  .step('charge', ({ key }) => `charged ${key}`, {
    undo: ({ key }) => {
      log.push(`undo charge ${key}`);
      if (broken.undoCharge) throw new Error('refund provider down');
    },
    retry: noRetry,
  })
  .waitFor('confirm', { signal: 'confirm', schema: z.object({}) })
  .finish();

/** Ends `failed` while `broken.kid` is set: its only step fails and the run compensates. */
const kid = j
  .workflow('test.op.kid', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
  .step(
    'boom',
    () => {
      if (broken.kid) throw new Error('kid broke');
      return 'kid ok';
    },
    { retry: noRetry },
  )
  .finish();
const parent = j
  .workflow('test.op.parent', { version: 1, input: z.object({}) })
  .child('kid', kid, { input: () => ({}) })
  .step('after', ({ results }) => `after ${results.kid}`)
  .finish();

/** `pick` always fails; its `next` is a function, so only a worker with the step's services can route it. */
const bodies = { first: 0, pick: 0 };
const routed = j
  .workflow('test.op.routed', { version: 1, input: z.object({}) })
  .step('first', () => ++bodies.first)
  .step(
    'pick',
    () => {
      bodies.pick++;
      throw new Error('pick down');
    },
    {
      retry: noRetry,
      output: z.object({ again: z.boolean() }),
      next: ({ result }) => (result.again ? 'first' : 'next'),
    },
  )
  .step('done', () => 'done')
  .finish();

const journal = j.compose({ workflows: [payout, unchecked, refunding, kid, parent, routed], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());
beforeEach(() => {
  broken.ship = false;
  broken.undoCharge = false;
  broken.kid = false;
  log.length = 0;
  shipKeys.length = 0;
  bodies.first = 0;
  bodies.pick = 0;
});

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}
const runRow = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row;
};
const stepRow = async (id: string, path: string, phase: 'do' | 'undo') => {
  const [row] = await db
    .select()
    .from(tables.workflowSteps)
    .where(
      and(
        eq(tables.workflowSteps.runId, id),
        eq(tables.workflowSteps.path, path),
        eq(tables.workflowSteps.phase, phase),
      ),
    );
  return row;
};
/** The data of the run's events of one type, oldest first. */
const dataOf = async (id: string, type: string) => {
  const rows = await db
    .select({ data: tables.events.data })
    .from(tables.events)
    .where(and(eq(tables.events.entityId, id), eq(tables.events.type, type)))
    .orderBy(asc(tables.events.seq));
  return rows.map(row => z.record(z.string(), z.unknown()).parse(row.data));
};
const childrenOf = async (id: string) => {
  const rows = await db
    .select({ id: tables.workflowRuns.id, state: tables.workflowRuns.state })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.parentId, id))
    .orderBy(asc(tables.workflowRuns.id));
  return rows;
};
const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};
const startPayout = async (prefix: string) => {
  const id = newId(prefix);
  expectOk(await journal.run(db, payout.start, { input: {}, id }, caller));
  await settle();
  return id;
};
const retryShip = (id: string) => journal.workflows.retryStep(db, { runId: id, path: 'ship', phase: 'do' }, operator);
const cancelRun = (id: string) => journal.run(db, payout.cancel, { runId: id, reason: 'stop' }, caller);

describe('retryStep', () => {
  it('retryStep runs a stuck step again with the same key', async () => {
    broken.ship = true;
    const id = await startPayout('retry');
    expect(await stepRow(id, 'ship', 'do')).toMatchObject({ status: 'failed', attempt: 1 });
    const stuck = await journal.workflows.run(db, id);
    expect(stuck?.run.stuck).toBe(true);

    broken.ship = false;
    expect(await retryShip(id)).toEqual({ how: 'rescheduled' });
    await settle();

    // One key for both attempts: a provider that dedupes on it dedupes the retry.
    expect(shipKeys).toEqual([
      { key: `${id}:ship:do`, attempt: 1 },
      { key: `${id}:ship:do`, attempt: 2 },
    ]);
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
    const finished = await runRow(id);
    expect(finished?.results).toMatchObject({ notify: 'sent t1' });
  });

  it('retryStep on an undo lets compensation finish', async () => {
    broken.undoCharge = true;
    const id = newId('undo');
    expectOk(await journal.run(db, refunding.start, { input: {}, id }, caller));
    await settle();
    expectOk(await journal.run(db, refunding.cancel, { runId: id, reason: 'stop' }, caller));
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'compensating', finishedAt: null });
    expect(await stepRow(id, 'charge', 'undo')).toMatchObject({ status: 'failed' });
    expect(log).toEqual([`undo charge ${id}:charge:undo`]);

    broken.undoCharge = false;
    orThrow(await journal.workflows.retryStep(db, { runId: id, path: 'charge', phase: 'undo' }, operator));
    await settle();

    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    expect(log).toEqual([`undo charge ${id}:charge:undo`, `undo charge ${id}:charge:undo`, 'undo reserve']);
  });

  it('retryStep on a failed child starts a new child once, never two', async () => {
    broken.kid = true;
    const id = newId('parent');
    expectOk(await journal.run(db, parent.start, { input: {}, id }, caller));
    await settle();
    expect(await childrenOf(id)).toEqual([{ id: `${id}/kid`, state: 'failed' }]);
    expect(await stepRow(id, 'kid', 'do')).toMatchObject({ status: 'failed' });

    broken.kid = false;
    const retry = () => journal.workflows.retryStep(db, { runId: id, path: 'kid', phase: 'do' }, operator);
    expect(await retry()).toEqual({ how: 'childrenRestarted' });
    // The new child exists at once, and the node waits for it again, so a second retry has nothing to retry.
    expect(await childrenOf(id)).toHaveLength(2);
    await expect(retry()).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'STEP_NOT_DEAD' } });
    await settle();

    expect(await childrenOf(id)).toEqual([
      { id: `${id}/kid`, state: 'failed' },
      { id: `${id}/kid~2`, state: 'completed' },
    ]);
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
    const parentRow = await runRow(id);
    expect(parentRow?.results).toMatchObject({ after: 'after kid ok' });
  });

  it('retryStep refuses a step that is not dead', async () => {
    const id = await startPayout('alive');
    const refused = (path: string, phase: 'do' | 'undo' = 'do') =>
      journal.workflows.retryStep(db, { runId: id, path, phase }, operator);
    // A finished run, a step that is done, a step that never ran, and a run nobody started.
    await expect(refused('ship')).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'WORKFLOW_FINISHED' },
    });
    const open = newId('open');
    expectOk(await journal.run(db, refunding.start, { input: {}, id: open }, caller));
    await settle();
    const openStep = (path: string, phase: 'do' | 'undo') =>
      journal.workflows.retryStep(db, { runId: open, path, phase }, operator);
    await expect(openStep('charge', 'do')).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'STEP_NOT_DEAD' },
    });
    await expect(openStep('charge', 'undo')).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'STEP_NOT_DEAD' },
    });
    await expect(openStep('nowhere', 'do')).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'STEP_NOT_DEAD' },
    });
    await expect(
      journal.workflows.retryStep(db, { runId: 'missing', path: 'ship', phase: 'do' }, operator),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'WORKFLOW_NOT_FOUND' } });
    await expect(
      journal.workflows.retryStep(db, { runId: open, path: 'charge', phase: 'do' }, { actor: ' ' }),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'BAD_ARGUMENT' } });
  });
});

describe('resolveStep', () => {
  it('resolveStep parses the result with the step schema and refuses a step without one', async () => {
    broken.ship = true;
    const id = await startPayout('resolve-bad');
    await expect(
      journal.workflows.resolveStep(db, { runId: id, path: 'ship', result: { tracking: 7 } }, operator),
    ).resolves.toMatchObject({ code: InvalidInput.code });
    // Nothing moved: the step is still dead and waits for someone.
    expect(await stepRow(id, 'ship', 'do')).toMatchObject({ status: 'failed' });

    const plain = newId('unchecked');
    expectOk(await journal.run(db, unchecked.start, { input: {}, id: plain }, caller));
    await settle();
    await expect(
      journal.workflows.resolveStep(db, { runId: plain, path: 'legacy', result: 'anything' }, operator),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'STEP_NOT_RESOLVABLE' } });

    // A step that is not dead cannot be resolved either.
    await expect(
      journal.workflows.resolveStep(db, { runId: id, path: 'charge', result: 'x' }, operator),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'STEP_NOT_DEAD' } });
  });

  it('resolveStep continues the run as if the step had completed', async () => {
    broken.ship = true;
    const id = await startPayout('resolve');
    orThrow(await journal.workflows.resolveStep(db, { runId: id, path: 'ship', result: { tracking: 't9' } }, operator));
    await settle();

    expect(shipKeys).toHaveLength(1);
    expect(await stepRow(id, 'ship', 'do')).toMatchObject({ status: 'done', result: { tracking: 't9' } });
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
    const finished = await runRow(id);
    expect(finished?.results).toMatchObject({ ship: { tracking: 't9' }, notify: 'sent t9' });
  });
});

describe('resolveStep with a next function', () => {
  it('resolveStep on a step with a next function routes on the worker and never re-runs the body', async () => {
    const forward = newId('routed');
    expectOk(await journal.run(db, routed.start, { input: {}, id: forward }, caller));
    await settle();
    expect(bodies).toEqual({ first: 1, pick: 1 });
    orThrow(
      await journal.workflows.resolveStep(db, { runId: forward, path: 'pick', result: { again: false } }, operator),
    );
    await settle();
    // `next` said carry on: the run finished, and the failed body ran once and never again.
    expect(bodies).toEqual({ first: 1, pick: 1 });
    expect(await runRow(forward)).toMatchObject({ state: 'completed' });
    const pickRow = await stepRow(forward, 'pick', 'do');
    expect(pickRow?.status).toBe('done');

    const back = newId('routed-back');
    expectOk(await journal.run(db, routed.start, { input: {}, id: back }, caller));
    await settle();
    orThrow(await journal.workflows.resolveStep(db, { runId: back, path: 'pick', result: { again: true } }, operator));
    await settle();
    // `next` jumped back: `first` ran a second visit. `pick` ran once more only because the loop reached it again.
    expect(bodies).toEqual({ first: 3, pick: 3 });
    const scheduled = await dataOf(back, 'NodeScheduled');
    expect(scheduled.map(data => data['key'])).toContain(`${back}:first:do:2`);
    const completedEvents = await dataOf(back, 'NodeCompleted');
    const completed = completedEvents.find(data => data['path'] === 'pick');
    expect(completed).toMatchObject({ resolvedBy: 'usr_ops', reason: operator.reason, executionId: 'exe_1' });
  });
});

describe('skipUndo', () => {
  it('skipUndo records the reason and lets compensation finish', async () => {
    broken.undoCharge = true;
    const id = newId('skip');
    expectOk(await journal.run(db, refunding.start, { input: {}, id }, caller));
    await settle();
    expectOk(await journal.run(db, refunding.cancel, { runId: id, reason: 'stop' }, caller));
    await settle();
    expect(await stepRow(id, 'charge', 'undo')).toMatchObject({ status: 'failed' });

    // Giving up work that stays done needs a reason on the record.
    await expect(
      journal.workflows.skipUndo(db, { runId: id, path: 'charge' }, { actor: 'usr_ops' }),
    ).resolves.toMatchObject({ code: TransactionDefect.code, cause: { code: 'BAD_ARGUMENT' } });
    orThrow(await journal.workflows.skipUndo(db, { runId: id, path: 'charge' }, operator));
    await settle();

    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    expect(log).toContain('undo reserve');
    expect(await stepRow(id, 'charge', 'undo')).toMatchObject({ status: 'skipped', reason: 'the provider is back' });
    const detail = await journal.workflows.run(db, id);
    expect(detail?.residual).toEqual(['charge']);
    await expect(journal.workflows.skipUndo(db, { runId: id, path: 'charge' }, operator)).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'WORKFLOW_FINISHED' },
    });
  });
});

describe('what the events say', () => {
  it("the operator's actor, reason and executionId are on the run's events", async () => {
    broken.ship = true;
    const retried = await startPayout('audit-retry');
    orThrow(await retryShip(retried));
    const [, scheduled] = await dataOf(retried, 'NodeScheduled').then(rows => rows.slice(-2));
    expect(scheduled).toMatchObject({
      path: 'ship',
      attempt: 2,
      actorId: 'usr_ops',
      reason: operator.reason,
      executionId: 'exe_1',
    });

    const resolved = await startPayout('audit-resolve');
    orThrow(
      await journal.workflows.resolveStep(db, { runId: resolved, path: 'ship', result: { tracking: 'r' } }, operator),
    );
    await settle();
    const completedEvents = await dataOf(resolved, 'NodeCompleted');
    const completed = completedEvents.find(data => data['path'] === 'ship');
    expect(completed).toMatchObject({ resolvedBy: 'usr_ops', reason: operator.reason, executionId: 'exe_1' });

    broken.undoCharge = true;
    const skipped = newId('audit-skip');
    expectOk(await journal.run(db, refunding.start, { input: {}, id: skipped }, caller));
    await settle();
    expectOk(await journal.run(db, refunding.cancel, { runId: skipped, reason: 'stop' }, caller));
    await settle();
    orThrow(await journal.workflows.skipUndo(db, { runId: skipped, path: 'charge' }, operator));
    await settle();
    const skippedEvents = await dataOf(skipped, 'NodeSkipped');
    const undone = skippedEvents.find(data => data['path'] === 'charge');
    expect(undone).toMatchObject({ actorId: 'usr_ops', reason: operator.reason, executionId: 'exe_1' });
  });
});

describe('cancel of a stuck run', () => {
  it('cancel of a stuck run undoes the completed steps, not the failed one', async () => {
    broken.ship = true;
    const id = await startPayout('stuck-cancel');
    const before = await journal.workflows.run(db, id);
    expect(before?.run.stuck).toBe(true);

    expectOk(await cancelRun(id));
    await settle();

    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    // `ship` never completed, so there is nothing of it to undo.
    expect(log).toEqual(['undo charge']);
    expect(await stepRow(id, 'ship', 'undo')).toBeUndefined();
    const after = await journal.workflows.run(db, id);
    expect(after?.run.stuck).toBe(false);
  });
});

const startRefunding = async (prefix: string) => {
  const id = newId(prefix);
  expectOk(await journal.run(db, refunding.start, { input: {}, id }, caller));
  await settle();
  return id;
};

describe('operator signal and cancel', () => {
  it("journal.workflows.signal checks the payload with the run's own version", async () => {
    const id = await startRefunding('op-signal');
    // An operator holds only JSON: the run's own wait refuses what it would not take, and nothing is stored.
    const bad = await journal.workflows.signal(
      db,
      { runId: id, name: 'confirm', deliveryId: 'd1', payload: 'not an object' },
      operator,
    );
    expect(isFailure(bad)).toBe(true);
    const unknown = await journal.workflows.signal(
      db,
      { runId: id, name: 'nobody.waits', deliveryId: 'd2', payload: {} },
      operator,
    );
    expect(isFailure(unknown)).toBe(true);
    expect(await runRow(id)).toMatchObject({ state: 'parked' });

    const woke = await journal.workflows.signal(
      db,
      { runId: id, name: 'confirm', deliveryId: 'd3', payload: {} },
      operator,
    );
    expect(woke).toEqual({ status: 'woke' });
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'completed' });
    expect(await dataOf(id, 'SignalReceived')).toEqual([
      expect.objectContaining({ deliveryId: 'd3', actorId: 'usr_ops', executionId: 'exe_1' }),
    ]);
  });

  it('journal.workflows.cancel is the same transition as def.cancel', async () => {
    const id = await startRefunding('op-cancel');
    const cancelled = orThrow(await journal.workflows.cancel(db, { runId: id, reason: 'customer withdrew' }, operator));
    expect(cancelled).toEqual({ state: 'compensating' });
    await settle();
    expect(await runRow(id)).toMatchObject({ state: 'cancelled' });
    // The same undo plan `def.cancel` runs: newest first.
    expect(log.filter(entry => entry.startsWith('undo'))).toEqual([
      expect.stringMatching(/^undo charge /),
      'undo reserve',
    ]);
    expect(await dataOf(id, 'CancelRequested')).toEqual([
      expect.objectContaining({ reason: 'customer withdrew', actorId: 'usr_ops', executionId: 'exe_1' }),
    ]);
    // A finished run cannot be cancelled again.
    expect(isFailure(await journal.workflows.cancel(db, { runId: id, reason: 'again' }, operator))).toBe(true);
  });
});
