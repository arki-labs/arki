/**
 * T(journal-foreman) — the workflows module on a real journal (PGlite). Why each rule exists:
 *  - an operator finds a stuck run from the reads alone, and secrets never leave through them;
 *  - every verb writes the Foreman approver and execution onto the run, so the run says who moved it;
 *  - an approval is for the run the operator saw: a run that changed since the preview is refused (E010);
 *  - domain refusals retain their 4xx codes; entropy failures keep their canonical 500 status.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Permit } from '@arki/admin/module';
import { RandomSourceUnavailable } from '@arki/contracts';
import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { backoff } from '@arki/resilience';

import * as ids from '../id.js';
import { initJournal } from '../journal.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { journalJobsModule } from './index.js';
import { foremanHarness } from './test-support.js';
import { JOURNAL_WORKFLOWS_ERROR_CODES, journalWorkflowsModule } from './workflows.js';

const NO_CTX = {} as const;
const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
const noRetry = backoff.constant(0).upTo(0);
const Shipped = z.object({ tracking: z.string() });
const Receipt = z.object({ by: z.string() });
const CODES = JOURNAL_WORKFLOWS_ERROR_CODES;

const broken = { ship: false, undoCharge: false };
const log: string[] = [];

/** `ship` fails while `broken.ship` is set, and declares an `output`, so an operator may give its result by hand. */
const payout = j
  .workflow('test.fm.payout', { version: 1, input: z.object({ card: z.string() }) })
  .step('charge', ({ input }) => `charged ${input.card}`, { undo: () => void log.push('undo charge') })
  .step(
    'ship',
    () => {
      if (broken.ship) throw new Error('carrier down password=hunter2');
      return { tracking: 't1' };
    },
    { retry: noRetry, output: Shipped, undo: () => void log.push('undo ship') },
  )
  .waitFor('receipt', { signal: 'receipt', schema: Receipt })
  .finish();

/** Waits at the end, with a step that has no undo in the middle, so a cancel has a plan to show. */
const checkout = j
  .workflow('test.fm.checkout', { version: 1, input: z.object({}) })
  .step('hold', () => 'held', { undo: () => void log.push('undo hold') })
  .step('charge', () => 'charged', { undo: () => void log.push('undo charge') })
  .step('payBack', () => 'paid back')
  .waitFor('confirm', { signal: 'confirm', schema: Receipt })
  .finish();

/** `charge` fails to undo while `broken.undoCharge` is set. */
const refunding = j
  .workflow('test.fm.refunding', { version: 1, input: z.object({}) })
  .step('reserve', () => 'reserved', { undo: () => void log.push('undo reserve') })
  .step('charge', () => 'charged', {
    undo: () => {
      if (broken.undoCharge) throw new Error('refund provider down');
      log.push('undo charge');
    },
    retry: noRetry,
  })
  .waitFor('confirm', { signal: 'confirm', schema: Receipt })
  .finish();

/** Its only step fails and has no `output`, so nothing could check a result an operator gave. */
const unchecked = j
  .workflow('test.fm.unchecked', { version: 1, input: z.object({}) })
  .step(
    'legacy',
    () => {
      throw new Error('legacy down');
    },
    { retry: noRetry },
  )
  .finish();

const defs = [payout, checkout, refunding, unchecked];
const journal = j.compose({ workflows: defs, workflowMeta });

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  broken.ship = false;
  broken.undoCharge = false;
  log.length = 0;
});

const foremanMeta = (permit: Permit) => ({ actorId: `foreman:${permit.approvedBy}` });
const module = (payload?: 'hidden' | 'redacted') =>
  journalWorkflowsModule({
    journal,
    db,
    meta: foremanMeta,
    ...(payload === undefined ? {} : { payload }),
  });
const permit = (revision: string, executionId = 'exe_1'): Permit => ({
  executionId,
  expectedRevision: revision,
  approvedBy: 'usr_alice',
});

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}
const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};
const stateOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row?.state;
};
const versionOf = async (id: string) => {
  const detail = await journal.workflows.run(db, id);
  return String(detail?.run.version);
};
/** The first event of the run that `test` accepts. */
const findEvent = async (id: string, test: (event: Awaited<ReturnType<typeof eventsOf>>[number]) => boolean) => {
  const events = await eventsOf(id);
  return events.find(event => test(event));
};
/** Every event of the run with its data and meta, oldest first. */
const eventsOf = (id: string) =>
  db
    .select({ type: tables.events.type, data: tables.events.data, meta: tables.events.meta })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));

const startPayout = async (prefix: string, stuck = true) => {
  broken.ship = stuck;
  const id = newId(prefix);
  expectOk(await journal.run(db, payout.start, { input: { card: 'card-4111' }, id }, caller));
  await settle();
  return id;
};
const startCheckout = async () => {
  const id = newId('checkout');
  expectOk(await journal.run(db, checkout.start, { input: {}, id }, caller));
  await settle();
  return id;
};
const startRefunding = async () => {
  const id = newId('refunding');
  expectOk(await journal.run(db, refunding.start, { input: {}, id }, caller));
  await settle();
  return id;
};

describe('reads', () => {
  it('every read lists runs an operator can find a stuck run from', async () => {
    const stuckId = await startPayout('reads', true);
    const parkedId = await startCheckout();
    const mod = module();

    const stuckRuns = await mod.reads.runs.run({ stuck: true, limit: 50 }, NO_CTX);
    expect(stuckRuns.runs.map(run => run.id)).toContain(stuckId);
    expect(stuckRuns.runs.map(run => run.id)).not.toContain(parkedId);
    expect(stuckRuns.runs.find(run => run.id === stuckId)).toMatchObject({
      name: 'test.fm.payout',
      version: 1,
      state: 'running',
      stuck: true,
      stranded: null,
    });

    const detail = await mod.reads.run.run({ runId: stuckId }, NO_CTX);
    expect(detail.run.stuck).toBe(true);
    expect(detail.steps.find(step => step.path === 'ship')).toMatchObject({ status: 'failed', stuck: true });
    expect(detail.steps.find(step => step.path === 'ship')?.error).not.toContain('hunter2');
    expect(detail.residual).toEqual([]);

    const counts = await mod.reads.counts.run({}, NO_CTX);
    expect(counts.counts).toContainEqual(
      expect.objectContaining({ name: 'test.fm.payout', version: 1, state: 'running' }),
    );
    expect(counts.counts).toContainEqual(expect.objectContaining({ name: 'test.fm.checkout', state: 'parked' }));

    const history = await mod.reads.history.run({ runId: stuckId, limit: 50 }, NO_CTX);
    expect(history.events[0]).toMatchObject({ type: 'RunStarted', seq: expect.any(Number) });

    expect(await mod.reads.strandedRuns.run({ limit: 50 }, NO_CTX)).toEqual({ stranded: [] });
    await expect(mod.reads.run.run({ runId: 'nope' }, NO_CTX)).rejects.toMatchObject({
      code: CODES.notFound,
      status: 404,
    });
  });
});

describe('retryStep', () => {
  it('retryStep from Foreman runs the stuck step again and records the operator', async () => {
    const id = await startPayout('retry', true);
    const mod = module();
    const input = { runId: id, path: 'ship', phase: 'do' as const, reason: 'the carrier is back' };

    const preview = await mod.actions.retryStep.runPreview(input, NO_CTX);
    expect(preview).toMatchObject({ how: 'rescheduled', count: 1, path: 'ship' });
    expect(preview.consequence).toContain('attempt 2');
    expect(preview.lastError).not.toContain('hunter2');

    broken.ship = false;
    const done = orThrow(await mod.actions.retryStep.runExecute(input, NO_CTX, permit(preview.revision, 'exe_retry')));
    expect(done).toEqual({ runId: id, how: 'rescheduled' });
    await settle();

    const written = await findEvent(
      id,
      event => event.type === 'NodeScheduled' && z.object({ actorId: z.string() }).safeParse(event.data).success,
    );
    expect(written?.data).toMatchObject({
      actorId: 'foreman:usr_alice',
      reason: 'the carrier is back',
      executionId: 'exe_retry',
    });
    const history = await mod.reads.history.run({ runId: id, limit: 100 }, NO_CTX);
    expect(history.events).toContainEqual(
      expect.objectContaining({
        actorId: 'foreman:usr_alice',
        reason: 'the carrier is back',
        executionId: 'exe_retry',
      }),
    );
    expect(await stateOf(id)).toBe('parked');
  });
});

describe('signal', () => {
  it('signal from Foreman wakes a run whose webhook never came, once per execution', async () => {
    const id = await startCheckout();
    const mod = module();
    const input = { runId: id, name: 'confirm', payload: { by: 'ops' }, reason: 'the webhook never came' };

    const preview = await mod.actions.signal.runPreview(input, NO_CTX);
    expect(preview.wakesNow).toBe(true);
    const first = orThrow(await mod.actions.signal.runExecute(input, NO_CTX, permit(preview.revision, 'exe_sig')));
    expect(first).toEqual({ runId: id, status: 'woke' });
    expect(await stateOf(id)).toBe('completed');

    // The same execution again (a lost answer, a retry) is the same delivery: it changes nothing.
    const again = orThrow(await mod.actions.signal.runExecute(input, NO_CTX, permit(preview.revision, 'exe_sig')));
    expect(again).toEqual({ runId: id, status: 'duplicate' });

    const runEvents = await eventsOf(id);
    const received = runEvents.filter(event => event.type === 'SignalReceived');
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toMatchObject({
      name: 'confirm',
      deliveryId: 'foreman:exe_sig',
      actorId: 'foreman:usr_alice',
      reason: 'the webhook never came',
      executionId: 'exe_sig',
    });
  });

  it('a bad signal payload is a 400 with E013, not a 500', async () => {
    const id = await startCheckout();
    const mod = module();
    const { client: foreman, lastStatus } = await foremanHarness(mod);

    // A signal no wait of the run's version takes is refused before approval.
    await expect(
      foreman.preview('workflow.signal', { runId: id, name: 'nobody', payload: {}, reason: 'x' }, ['workflow:signal']),
    ).rejects.toMatchObject({ code: CODES.badSignal });
    expect(lastStatus()).toBe(400);

    // The payload is checked by the run's own version when the action runs, and nothing is stored.
    await expect(
      mod.actions.signal.runExecute(
        { runId: id, name: 'confirm', payload: { by: 5 }, reason: 'x' },
        NO_CTX,
        permit(await versionOf(id)),
      ),
    ).rejects.toMatchObject({ code: CODES.badSignal, status: 400 });
    expect(await stateOf(id)).toBe('parked');
  });
});

describe('resolveStep and skipUndo', () => {
  it('resolveStep and skipUndo need workflow:resolve and record the reason', async () => {
    const actions = Object.values(module().actions).map(action => [action.id, action.permission, action.risk]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['workflow.retryStep', 'journal:retry', 'low'],
        ['workflow.resolveStep', 'workflow:resolve', 'high'],
        ['workflow.skipUndo', 'workflow:resolve', 'high'],
        ['workflow.cancel', 'workflow:cancel', 'high'],
      ]),
    );
    expect(Object.values(module().reads).map(read => read.permission)).toEqual(
      Object.values(module().reads).map(() => 'workflow:read'),
    );

    const mod = module();
    const stuckId = await startPayout('resolve', true);
    const resolveInput = { runId: stuckId, path: 'ship', result: { tracking: 'by-hand' }, reason: 'shipped by phone' };
    const resolvePreview = await mod.actions.resolveStep.runPreview(resolveInput, NO_CTX);
    orThrow(
      await mod.actions.resolveStep.runExecute(resolveInput, NO_CTX, permit(resolvePreview.revision, 'exe_resolve')),
    );
    await settle();
    const resolved = await findEvent(
      stuckId,
      event => z.object({ resolution: z.unknown() }).safeParse(event.data).success && event.type === 'NodeScheduled',
    );
    expect(resolved?.data).toMatchObject({
      actorId: 'foreman:usr_alice',
      reason: 'shipped by phone',
      executionId: 'exe_resolve',
    });
    const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, stuckId));
    expect(row?.results).toMatchObject({ ship: { tracking: 'by-hand' } });

    broken.undoCharge = true;
    const undoId = await startRefunding();
    expectOk(await journal.run(db, refunding.cancel, { runId: undoId, reason: 'stop' }, caller));
    await settle();
    const skipInput = { runId: undoId, path: 'charge', reason: 'refunded by hand at the bank' };
    const skipPreview = await mod.actions.skipUndo.runPreview(skipInput, NO_CTX);
    expect(skipPreview.consequence).toContain('residual');
    orThrow(await mod.actions.skipUndo.runExecute(skipInput, NO_CTX, permit(skipPreview.revision, 'exe_skip')));
    await settle();
    const skipped = await findEvent(
      undoId,
      event => event.type === 'NodeSkipped' && z.object({ executionId: z.string() }).safeParse(event.data).success,
    );
    expect(skipped?.data).toMatchObject({
      actorId: 'foreman:usr_alice',
      reason: 'refunded by hand at the bank',
      executionId: 'exe_skip',
    });
    const undone = await journal.workflows.run(db, undoId);
    expect(undone?.residual).toEqual(['charge']);
    expect(await stateOf(undoId)).toBe('cancelled');
  });
});

describe('cancel', () => {
  it('cancel preview lists the undo plan in reverse order', async () => {
    const id = await startCheckout();
    const mod = module();
    const preview = await mod.actions.cancel.runPreview({ runId: id, reason: 'customer left' }, NO_CTX);

    expect(preview.plan).toEqual([
      { path: 'payBack', action: 'none' },
      { path: 'charge', action: 'undo' },
      { path: 'hold', action: 'undo' },
    ]);
    expect(preview.consequence).toContain('2 step(s) will be undone, newest first: charge, hold.');
    expect(preview.consequence).toContain('payBack has no undo and is skipped.');

    const done = orThrow(
      await mod.actions.cancel.runExecute(
        { runId: id, reason: 'customer left' },
        NO_CTX,
        permit(preview.revision, 'exe_cancel'),
      ),
    );
    expect(done.state).toBe('compensating');
    await settle();
    expect(log).toEqual(['undo charge', 'undo hold']);
    expect(await stateOf(id)).toBe('cancelled');
    const requested = await findEvent(id, event => event.type === 'CancelRequested');
    expect(requested?.data).toMatchObject({ actorId: 'foreman:usr_alice', reason: 'customer left' });
  });
});

describe('revision', () => {
  it('an action on a run that changed since its preview is refused with E010', async () => {
    const id = await startPayout('stale', true);
    const mod = module();
    const input = { runId: id, path: 'ship', phase: 'do' as const };
    const preview = await mod.actions.retryStep.runPreview(input, NO_CTX);

    // Someone else cancelled the run after the operator looked: its charge now undoes.
    expectOk(await journal.run(db, payout.cancel, { runId: id, reason: 'stop' }, caller));
    await expect(mod.actions.retryStep.runExecute(input, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: CODES.staleRevision,
      status: 409,
    });
    expect(CODES.staleRevision).toBe('ARKI_JOURNAL_E010');
    await settle();
  });

  it('a retry of dead jobs is refused when another job of the run died after the preview', async () => {
    const mod = module();
    // Another deploy, without this workflow's code, claims the run's first step: the job dies stranded.
    const deployless = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const other = deployless
      .workflow('test.fm.other', { version: 1, input: z.object({}) })
      .step('noop', () => null)
      .finish();
    const deploylessJournal = deployless.compose({ workflows: [other], workflowMeta });
    const id = newId('dead');
    expectOk(await journal.run(db, checkout.start, { input: {}, id }, caller));
    await deploylessJournal.drain(db).then(result => orThrow(result));

    const input = { runId: id, path: 'hold', phase: 'do' as const };
    const preview = await mod.actions.retryStep.runPreview(input, NO_CTX);
    expect(preview).toMatchObject({ how: 'jobRetried', count: 1 });

    // A job's death writes no event, so the run's version is the same; the approval still must not cover a new death.
    const [dead] = await db
      .select()
      .from(tables.jobs)
      .where(and(eq(tables.jobs.runId, id), isNotNull(tables.jobs.deadAt)));
    if (dead === undefined) throw new Error('the stranded step job should be dead');
    await db.insert(tables.jobs).values({ ...dead, id: `${dead.id}_late`, effect: 'workflow.timer' });
    await expect(mod.actions.retryStep.runExecute(input, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: CODES.staleRevision,
      status: 409,
    });
  });
});

describe('error mapping', () => {
  it('finished, compensating, not-found and stranded runs map to their codes', async () => {
    const mod = module();
    const cancelInput = { runId: '', reason: 'stop' };

    // finished: E011
    const doneId = await startCheckout();
    expectOk(
      await journal.run(
        db,
        checkout.signal('confirm'),
        { runId: doneId, deliveryId: 'd_done', payload: { by: 'ops' } },
        caller,
      ),
    );
    await expect(mod.actions.cancel.runPreview({ ...cancelInput, runId: doneId }, NO_CTX)).rejects.toMatchObject({
      code: CODES.finished,
      status: 409,
    });

    // compensating: E014
    const stoppingId = await startPayout('mapping', true);
    expectOk(await journal.run(db, payout.cancel, { runId: stoppingId, reason: 'stop' }, caller));
    await expect(mod.actions.cancel.runPreview({ ...cancelInput, runId: stoppingId }, NO_CTX)).rejects.toMatchObject({
      code: CODES.compensating,
      status: 409,
    });
    await settle();

    // not found: E016, from a preview and from a read
    await expect(mod.actions.cancel.runPreview({ ...cancelInput, runId: 'wfr_nope' }, NO_CTX)).rejects.toMatchObject({
      code: CODES.notFound,
      status: 404,
    });
    await expect(
      mod.actions.retryStep.runPreview({ runId: 'wfr_nope', path: 'ship', phase: 'do' }, NO_CTX),
    ).rejects.toMatchObject({ code: CODES.notFound });

    // stranded: E017. The module's journal has no code for the run's workflow.
    const original = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const ghost = original
      .workflow('test.fm.ghost', { version: 1, input: z.object({}) })
      .waitFor('never', { signal: 'never', schema: Receipt })
      .finish();
    const ghostJournal = original.compose({ workflows: [ghost], workflowMeta });
    const ghostId = newId('ghost');
    expectOk(await ghostJournal.run(db, ghost.start, { input: {}, id: ghostId }, caller));
    await ghostJournal.drain(db).then(result => orThrow(result));
    await expect(mod.actions.cancel.runPreview({ ...cancelInput, runId: ghostId }, NO_CTX)).rejects.toMatchObject({
      code: CODES.stranded,
      status: 409,
    });
    const strandedNow = await mod.reads.strandedRuns.run({ limit: 50 }, NO_CTX);
    expect(strandedNow.stranded.map(run => run.id)).toContain(ghostId);

    // the journal's own refusals at execute time: a step that is not dead (E012) and one with no output schema (E015)
    const calmId = await startCheckout();
    await expect(
      mod.actions.retryStep.runExecute(
        { runId: calmId, path: 'hold', phase: 'do' },
        NO_CTX,
        permit(await versionOf(calmId)),
      ),
    ).rejects.toMatchObject({ code: CODES.stepNotDead, status: 409 });
    const legacyId = newId('legacy');
    expectOk(await journal.run(db, unchecked.start, { input: {}, id: legacyId }, caller));
    await settle();
    await expect(
      mod.actions.resolveStep.runPreview({ runId: legacyId, path: 'legacy', result: {}, reason: 'x' }, NO_CTX),
    ).rejects.toMatchObject({ code: CODES.stepNotResolvable, status: 409 });
    await expect(
      mod.actions.resolveStep.runExecute(
        { runId: legacyId, path: 'legacy', result: {}, reason: 'x' },
        NO_CTX,
        permit(await versionOf(legacyId)),
      ),
    ).rejects.toMatchObject({ code: CODES.stepNotResolvable, status: 409 });
  });
});

describe('payload', () => {
  it('payload hidden keeps inputs and results out of reads', async () => {
    const id = await startPayout('hidden', true);
    // The webhook came early: it waits unconsumed on the run.
    expectOk(
      await journal.run(
        db,
        payout.signal('receipt'),
        { runId: id, deliveryId: 'd1', payload: { by: 'secret-person' } },
        caller,
      ),
    );
    const everything = async (mod: ReturnType<typeof module>) =>
      JSON.stringify([
        await mod.reads.run.run({ runId: id }, NO_CTX),
        await mod.reads.history.run({ runId: id, limit: 100 }, NO_CTX),
        await mod.reads.runs.run({ limit: 100 }, NO_CTX),
      ]);

    const hidden = await everything(module());
    expect(hidden).not.toContain('card-4111');
    expect(hidden).not.toContain('secret-person');
    expect(hidden).not.toContain('charged');
    expect(hidden).not.toContain('hunter2');
    expect(await module().reads.run.run({ runId: id }, NO_CTX)).not.toHaveProperty('input');

    const redacted = await everything(module('redacted'));
    expect(redacted).toContain('card-4111');
    expect(redacted).toContain('secret-person');
    expect(redacted).not.toContain('hunter2');
  });
});

describe('jobs module', () => {
  it('purgeDead preview counts only jobs it will purge', async () => {
    await db.delete(tables.jobs).where(isNotNull(tables.jobs.id));
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    await db.insert(tables.jobs).values([
      { id: 'job_loose', kind: 'queue', jobName: 'demo', args: {}, deadAt: longAgo },
      { id: 'job_owned', kind: 'queue', jobName: 'demo', args: {}, deadAt: longAgo, runId: 'wfr_owned' },
    ]);
    const jobs = journalJobsModule({ journal, db });
    const preview = await jobs.actions.purgeDead.runPreview({ olderThanDays: 31, limit: 100 }, NO_CTX);
    expect(preview.deadJobs).toBe(1);
    expect(preview.consequence).not.toContain('counted above');
    const done = orThrow(
      await jobs.actions.purgeDead.runExecute({ olderThanDays: 31, limit: 100 }, NO_CTX, permit(preview.revision)),
    );
    expect(done.archived + done.deleted).toBe(preview.deadJobs);
    expect(
      await db
        .select()
        .from(tables.jobs)
        .where(and(eq(tables.jobs.id, 'job_owned'))),
    ).toHaveLength(1);
    await db.delete(tables.jobs).where(isNotNull(tables.jobs.id));
  });
});

describe('workflow action entropy failures', () => {
  it.each(
    (['retryStep', 'resolveStep', 'skipUndo', 'cancel', 'signal'] as const).flatMap(action =>
      [false, true].map(defect => ({ action, defect })),
    ),
  )('forwards the original refusal through $action (defect: $defect)', async ({ action, defect }) => {
    const mod = module();
    const refused = defect
      ? UnexpectedDefect({ cause: new Error('private entropy fault') })
      : RandomSourceUnavailable();
    switch (action) {
      case 'retryStep': {
        const runId = await startPayout('entropy-retry', true);
        const input = { runId, path: 'ship', phase: 'do' as const, reason: 'retry' };
        const preview = await mod.actions.retryStep.runPreview(input, NO_CTX);
        vi.spyOn(ids, 'commandId').mockReturnValue(refused);
        expect(await mod.actions.retryStep.runExecute(input, NO_CTX, permit(preview.revision))).toBe(refused);
        break;
      }
      case 'resolveStep': {
        const runId = await startPayout('entropy-resolve', true);
        const input = { runId, path: 'ship', result: { tracking: 'manual' }, reason: 'resolve' };
        const preview = await mod.actions.resolveStep.runPreview(input, NO_CTX);
        vi.spyOn(ids, 'commandId').mockReturnValue(refused);
        expect(await mod.actions.resolveStep.runExecute(input, NO_CTX, permit(preview.revision))).toBe(refused);
        break;
      }
      case 'skipUndo': {
        broken.undoCharge = true;
        const runId = await startRefunding();
        orThrow(await journal.run(db, refunding.cancel, { runId, reason: 'stop' }, caller));
        await settle();
        const input = { runId, path: 'charge', reason: 'skip' };
        const preview = await mod.actions.skipUndo.runPreview(input, NO_CTX);
        vi.spyOn(ids, 'commandId').mockReturnValue(refused);
        expect(await mod.actions.skipUndo.runExecute(input, NO_CTX, permit(preview.revision))).toBe(refused);
        break;
      }
      case 'cancel': {
        const runId = await startCheckout();
        const input = { runId, reason: 'stop' };
        const preview = await mod.actions.cancel.runPreview(input, NO_CTX);
        vi.spyOn(ids, 'commandId').mockReturnValue(refused);
        expect(await mod.actions.cancel.runExecute(input, NO_CTX, permit(preview.revision))).toBe(refused);
        break;
      }
      case 'signal': {
        const runId = await startCheckout();
        const input = { runId, name: 'confirm', payload: { by: 'ops' }, reason: 'signal' };
        const preview = await mod.actions.signal.runPreview(input, NO_CTX);
        vi.spyOn(ids, 'commandId').mockReturnValue(refused);
        expect(await mod.actions.signal.runExecute(input, NO_CTX, permit(preview.revision))).toBe(refused);
        break;
      }
    }
  });
});
