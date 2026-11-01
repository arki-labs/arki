/**
 * T(journal-foreman) — the run and limit verbs of the workflows module on a real journal (PGlite). Why each rule exists:
 *  - one permission per verb (founder, 2026-10-23): an operator let tag runs must not be able to replay them or pause
 *    a limit, so each verb is refused under any other verb's scope;
 *  - an approval is for the run or limit the operator saw: a change since the preview is refused (E010), but a
 *    metadata or tag change is progress, not a move, so it voids no approval, its own kind included;
 *  - a limit's approval is taken on its version, which only operator changes move: runs that take a slot do not;
 *  - every verb is answered and recorded with its receipt, and a journal refusal keeps its own code and data.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Permit } from '@arki/admin/module';
import { AdminScopeDenied } from '@arki/admin/module';
import { isFailure, orThrow } from '@arki/failure';

import { CommandConflict, WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { journalWorkflowsModule } from './index.js';
import { JOURNAL_WORKFLOWS_ERROR_CODES } from './shapes.js';
import { foremanHarness } from './test-support.js';
import { WORKFLOW_PERMISSIONS, workflowsModule } from './workflows.js';

const NO_CTX = {} as const;
const CODES = JOURNAL_WORKFLOWS_ERROR_CODES;
const caller = { actorId: 'usr_test' };
const ops = { actor: 'usr_ops', reason: 'someone else' };

const accountInput = z.object({ account: z.string() });
const byAccount = ({ account }: { account: string }) => account;
type Concurrency = NonNullable<Parameters<typeof j.workflow<typeof accountInput>>[1]['concurrency']>;

/** A run that parks until it is told to go, so it holds its slots for as long as a test needs. */
const held = (name: string, concurrency?: Concurrency) =>
  j
    .workflow(name, { version: 1, input: accountInput, ...(concurrency === undefined ? {} : { concurrency }) })
    .waitFor('go', { signal: 'go', schema: z.object({}) })
    .finish();

/** Shared by two workflows: one refuses a busy start, one queues it. */
const gate = j.limit({ name: 'test.fv.gate', total: 5 });
/** Only the stale-permit and protocol tests change it, so they do not disturb the admission tests. */
const spare = j.limit({ name: 'test.fv.spare', total: 5 });

const parked = held('test.fv.parked');
/** One run per account, refused when busy: its own limit is `workflow/test.fv.single`. */
const single = held('test.fv.single', { key: byAccount, limit: 1, onBusy: 'refuse' });
const gatedRefuse = held('test.fv.gated-refuse', { shared: [gate], onBusy: 'refuse' });
const gatedQueue = held('test.fv.gated-queue', { shared: [gate], onBusy: 'queue' });
const spared = held('test.fv.spared', { shared: [spare], onBusy: 'refuse' });
/** Its first node is a step, so a delayed run of it has a first step waiting for its first try. */
const quick = j
  .workflow('test.fv.quick', { version: 1, input: accountInput })
  .step('work', ({ input }) => input.account)
  .finish();

const journal = j.compose({
  workflows: [parked, single, gatedRefuse, gatedQueue, spared, quick],
  workflowMeta: { actorId: 'system:workflow' },
});

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

const module = () =>
  workflowsModule({ journal, db, meta: permit => ({ actorId: `foreman:${permit.approvedBy}` }), payload: 'redacted' });
const permit = (revision: string, executionId = newId('exe')): Permit => ({
  executionId,
  expectedRevision: revision,
  approvedBy: 'usr_alice',
});

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}
type Starter = { readonly start: typeof parked.start };
const start = (def: Starter, account: string, extra: { readonly delay?: '1h' } = {}) =>
  journal.run(db, def.start, { input: { account }, ...extra }, caller);
const startParked = async (def: Starter = parked, account = newId('acc')) => {
  const { runId } = orThrow(await start(def, account));
  await settle();
  return runId;
};
const runOf = async (runId: string) => orThrow(await module().reads.run.run({ runId }, NO_CTX));
const goSignal = (def: typeof parked, runId: string) =>
  journal.run(db, def.signal('go'), { runId, deliveryId: newId('dlv'), payload: {} }, caller);

describe('permissions', () => {
  it('each new verb has its own permission and risk, so a tag permission never lets an operator replay or pause', () => {
    const actions = Object.values(module().actions).map(action => [action.id, action.permission, action.risk]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['workflow.setMetadata', 'workflow:metadata', 'low'],
        ['workflow.addTags', 'workflow:metadata', 'low'],
        ['workflow.reschedule', 'workflow:reschedule', 'medium'],
        ['workflow.replay', 'workflow:replay', 'medium'],
        ['workflow.limits.pause', 'workflow:limits', 'high'],
        ['workflow.limits.resume', 'workflow:limits', 'high'],
        ['workflow.limits.override', 'workflow:limits', 'high'],
        ['workflow.limits.reset', 'workflow:limits', 'high'],
      ]),
    );
    expect(Object.values(module().reads).map(read => read.permission)).toEqual(
      Object.values(module().reads).map(() => WORKFLOW_PERMISSIONS.read),
    );
  });

  it('over the signed protocol, every verb is refused under the others’ scopes and recorded under its own', async () => {
    const {
      client: foreman,
      lastStatus,
      permit: claim,
      receiptOf,
    } = await foremanHarness(
      journalWorkflowsModule({ journal, db, meta: approved => ({ actorId: `foreman:${approved.approvedBy}` }) }),
    );
    const runId = await startParked();
    const delayed = orThrow(await start(quick, newId('acc'), { delay: '1h' })).runId;
    const verbs = [
      ['workflow.setMetadata', { runId, change: { kind: 'set', patch: { step: 'two' } } }, 'workflow:metadata'],
      ['workflow.addTags', { runId, tags: ['vip'] }, 'workflow:metadata'],
      ['workflow.reschedule', { runId: delayed, delay: '2h', reason: 'customer asked' }, 'workflow:reschedule'],
      ['workflow.replay', { runId, reason: 'bad data fixed' }, 'workflow:replay'],
      ['workflow.limits.pause', { name: 'test.fv.spare', reason: 'incident' }, 'workflow:limits'],
      ['workflow.limits.resume', { name: 'test.fv.spare', reason: 'incident over' }, 'workflow:limits'],
      ['workflow.limits.override', { name: 'test.fv.spare', total: 9, reason: 'more room' }, 'workflow:limits'],
      ['workflow.limits.reset', { name: 'test.fv.spare', reason: 'back to code' }, 'workflow:limits'],
    ] as const;
    const scopes = [...new Set(verbs.map(verb => verb[2]))];

    for (const [id, input, scope] of verbs) {
      const others = scopes.filter(other => other !== scope);
      await expect(foreman.preview(id, input, [WORKFLOW_PERMISSIONS.read, ...others])).resolves.toMatchObject({
        code: AdminScopeDenied.code,
      });
      expect(lastStatus()).toBe(403);

      const { revision } = z.object({ revision: z.string() }).parse(await foreman.preview(id, input, [scope]));
      const executionId = newId('exe_wire');
      orThrow(await foreman.execute(id, input, { scopes: [scope], permit: claim(executionId, id, revision) }));
      expect(await receiptOf(executionId)).toMatchObject({ status: 'applied', actionId: id });
    }
    expect(await runOf(runId)).toMatchObject({ run: { tags: ['vip'] }, metadata: '{"step":"two"}' });
    expect(orThrow(await journal.limits.get(db, 'test.fv.spare'))).toMatchObject({
      paused: false,
      override: { total: null },
    });
  });
});

describe('setMetadata and addTags', () => {
  it('two metadata actions approved on the same run both apply: progress never voids an approval', async () => {
    const runId = await startParked();
    const mod = module();
    const first = { runId, change: { kind: 'set' as const, patch: { stage: 'review' } } };
    const second = { runId, change: { kind: 'increment' as const, key: 'retries', by: 2 } };
    const tags = { runId, tags: ['vip', 'vip', 'eu'] };
    const [firstPreview, secondPreview, tagsPreview] = await Promise.all([
      mod.actions.setMetadata.runPreview(first, NO_CTX),
      mod.actions.setMetadata.runPreview(second, NO_CTX),
      mod.actions.addTags.runPreview(tags, NO_CTX),
    ]);
    expect(firstPreview).toMatchObject({ keys: ['stage'] });
    expect(firstPreview.consequence).not.toContain('review');
    expect(tagsPreview.added).toEqual(['vip', 'eu']);

    expect(orThrow(await mod.actions.setMetadata.runExecute(first, NO_CTX, permit(firstPreview.revision)))).toEqual({
      runId,
      keys: ['stage'],
    });
    orThrow(await mod.actions.setMetadata.runExecute(second, NO_CTX, permit(secondPreview.revision)));
    expect(orThrow(await mod.actions.addTags.runExecute(tags, NO_CTX, permit(tagsPreview.revision)))).toEqual({
      runId,
      tags: ['vip', 'eu'],
    });
    const after = await runOf(runId);
    expect(after.metadata).toBe('{"retries":2,"stage":"review"}');
    expect(after.run.tags).toEqual(['vip', 'eu']);
    const history = await mod.reads.history.run({ runId, limit: 50 }, NO_CTX);
    expect(history.events.filter(event => event.actorId === 'foreman:usr_alice').map(event => event.type)).toEqual([
      'MetadataChanged',
      'MetadataChanged',
      'RunTagged',
    ]);
  });

  it('a metadata action does not void a cancel approved before it', async () => {
    const runId = await startParked();
    const mod = module();
    const cancelPreview = await mod.actions.cancel.runPreview({ runId, reason: 'customer left' }, NO_CTX);
    const tag = { runId, tags: ['cancelling'] };
    const tagPreview = await mod.actions.addTags.runPreview(tag, NO_CTX);
    orThrow(await mod.actions.addTags.runExecute(tag, NO_CTX, permit(tagPreview.revision)));

    const done = orThrow(
      await mod.actions.cancel.runExecute({ runId, reason: 'customer left' }, NO_CTX, permit(cancelPreview.revision)),
    );
    expect(done.state).toBe('cancelled');
  });

  it('a metadata or tag action on a run that moved since its preview is refused (E010), or ended (E011)', async () => {
    const mod = module();
    const delayed = orThrow(await start(quick, newId('acc'), { delay: '1h' })).runId;
    const change = { runId: delayed, change: { kind: 'remove' as const, key: 'stage' } };
    const tags = { runId: delayed, tags: ['late'] };
    const changePreview = await mod.actions.setMetadata.runPreview(change, NO_CTX);
    const tagsPreview = await mod.actions.addTags.runPreview(tags, NO_CTX);
    // Someone moved the run's start after the operator looked: the run moved.
    orThrow(await journal.workflows.reschedule(db, { runId: delayed, delay: '3h' }, ops));
    await expect(
      mod.actions.setMetadata.runExecute(change, NO_CTX, permit(changePreview.revision)),
    ).rejects.toMatchObject({ code: CODES.staleRevision, status: 409 });
    await expect(mod.actions.addTags.runExecute(tags, NO_CTX, permit(tagsPreview.revision))).rejects.toMatchObject({
      code: CODES.staleRevision,
      status: 409,
    });

    const runId = await startParked();
    const lastPreview = await mod.actions.addTags.runPreview({ runId, tags: ['late'] }, NO_CTX);
    // The run's signal came and it completed: no change applies to a finished run.
    orThrow(await goSignal(parked, runId));
    await expect(
      mod.actions.addTags.runExecute({ runId, tags: ['late'] }, NO_CTX, permit(lastPreview.revision)),
    ).rejects.toMatchObject({ code: CODES.finished });
  });
});

describe('reschedule', () => {
  it('moves a delayed run that has not started, and the read shows its new start', async () => {
    const runId = orThrow(await start(quick, newId('acc'), { delay: '1h' })).runId;
    const mod = module();
    const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const input = { runId, at, reason: 'customer asked for later' };
    const preview = await mod.actions.reschedule.runPreview(input, NO_CTX);
    expect(preview.newStartAt).toBe(at);
    expect(Date.parse(preview.startAt)).toBeLessThan(Date.parse(at));

    expect(orThrow(await mod.actions.reschedule.runExecute(input, NO_CTX, permit(preview.revision)))).toEqual({
      runId,
      startAt: at,
    });
    const { run } = await runOf(runId);
    expect(run).toMatchObject({ startAt: at, delayedUntil: at, state: 'running' });
  });

  it('refuses a run that has started, before approval, with the journal’s own conflict code', async () => {
    const runId = await startParked();
    await expect(
      module().actions.reschedule.runPreview({ runId, delay: '1h', reason: 'later' }, NO_CTX),
    ).rejects.toMatchObject({ code: CommandConflict({ detail: '' }).code, status: 409 });
  });

  it('a reschedule by someone else since the preview voids the approval (E010)', async () => {
    const runId = orThrow(await start(quick, newId('acc'), { delay: '1h' })).runId;
    const mod = module();
    const input = { runId, delay: '2h' as const, reason: 'later' };
    const preview = await mod.actions.reschedule.runPreview(input, NO_CTX);
    orThrow(await journal.workflows.reschedule(db, { runId, delay: '5h' }, ops));
    await expect(mod.actions.reschedule.runExecute(input, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: CODES.staleRevision,
    });
  });
});

describe('replay', () => {
  it('starts a new run from a finished one with the overrides, and the reads show where it came from', async () => {
    const old = await startParked();
    orThrow(await goSignal(parked, old));
    await settle();
    const mod = module();
    const input = {
      runId: old,
      overrides: { tags: ['again'], priority: 7, maxAttempts: 2, timeout: 30 },
      reason: 'the bug is fixed',
    };
    const preview = await mod.actions.replay.runPreview(input, NO_CTX);
    expect(preview).toMatchObject({ state: 'completed', overridden: ['tags', 'maxAttempts', 'timeout', 'priority'] });

    const done = orThrow(await mod.actions.replay.runExecute(input, NO_CTX, permit(preview.revision)));
    expect(done).toMatchObject({ replayOf: old, state: 'running' });
    expect(done.runId).not.toBe(old);
    await settle();
    const { run: again } = await runOf(done.runId);
    expect(again).toMatchObject({
      replayOf: old,
      tags: ['again'],
      priority: 7,
      maxAttempts: 2,
      stepTimeoutMs: 30_000,
      state: 'parked',
    });
  });

  it('a replay at a busy key returns WorkflowBusy with its limit and reason, not a 500', async () => {
    const account = newId('acc');
    const first = await startParked(single, account);
    orThrow(await journal.workflows.cancel(db, { runId: first, reason: 'stop' }, ops));
    await startParked(single, account);
    const mod = module();
    const input = { runId: first, reason: 'try again' };
    const preview = await mod.actions.replay.runPreview(input, NO_CTX);
    const busy = await mod.actions.replay.runExecute(input, NO_CTX, permit(preview.revision));
    expect(WorkflowBusy.is(busy)).toBe(true);
    expect(isFailure(busy) && busy.status).toBe(409);
    expect(busy).toMatchObject({ data: { limitName: 'workflow/test.fv.single', reason: 'full', key: account } });
  });

  it('a run that moved since the replay preview voids the approval (E010)', async () => {
    const runId = await startParked();
    const mod = module();
    const preview = await mod.actions.replay.runPreview({ runId, reason: 'again' }, NO_CTX);
    orThrow(await goSignal(parked, runId));
    await expect(
      mod.actions.replay.runExecute({ runId, reason: 'again' }, NO_CTX, permit(preview.revision)),
    ).rejects.toMatchObject({ code: CODES.staleRevision });
  });
});

describe('limits', () => {
  it('pause refuses or queues new starts; resume starts the queued run', async () => {
    const mod = module();
    const pause = { name: 'test.fv.gate', reason: 'the provider is down' };
    const preview = await mod.actions.pauseLimit.runPreview(pause, NO_CTX);
    expect(preview.limit).toMatchObject({ paused: false, version: 0 });
    expect(orThrow(await mod.actions.pauseLimit.runExecute(pause, NO_CTX, permit(preview.revision)))).toMatchObject({
      paused: true,
      version: 1,
    });

    const refused = await start(gatedRefuse, newId('acc'));
    expect(refused).toMatchObject({ data: { reason: 'paused', limitName: 'test.fv.gate' } });
    const queued = orThrow(await start(gatedQueue, newId('acc'))).runId;
    const { run: waiting } = await runOf(queued);
    expect(waiting.state).toBe('queued');
    const listed = await mod.reads.limits.run({}, NO_CTX);
    expect(listed.limits.find(limit => limit.name === 'test.fv.gate')).toMatchObject({ paused: true, queued: 1 });

    const resume = { name: 'test.fv.gate', reason: 'the provider is back' };
    const resumePreview = await mod.actions.resumeLimit.runPreview(resume, NO_CTX);
    expect(resumePreview.consequence).toContain('1 queued');
    orThrow(await mod.actions.resumeLimit.runExecute(resume, NO_CTX, permit(resumePreview.revision)));
    await settle();
    const { run: promoted } = await runOf(queued);
    expect(promoted.state).toBe('parked');
    expect(orThrow(await start(gatedRefuse, newId('acc')))).toMatchObject({ runId: expect.any(String) });
  });

  it('override and reset change which starts are admitted, for one key or the whole limit', async () => {
    const mod = module();
    const name = 'workflow/test.fv.single';
    const account = newId('acc');
    await startParked(single, account);
    expect(await start(single, account)).toMatchObject({ data: { reason: 'full' } });

    const raise = { name, key: account, perKey: 2, ttl: '1h' as const, reason: 'backfill' };
    const raisePreview = await mod.actions.overrideLimit.runPreview(raise, NO_CTX);
    expect(raisePreview.consequence).toContain('2 run(s) at once');
    const raised = orThrow(await mod.actions.overrideLimit.runExecute(raise, NO_CTX, permit(raisePreview.revision)));
    expect(raised.keys).toEqual([expect.objectContaining({ key: account, perKey: 2 })]);
    orThrow(await start(single, account));

    const stop = { name, total: 0, reason: 'stop everything' };
    const stopPreview = await mod.actions.overrideLimit.runPreview(stop, NO_CTX);
    expect(stopPreview.consequence).toContain('no run');
    orThrow(await mod.actions.overrideLimit.runExecute(stop, NO_CTX, permit(stopPreview.revision)));
    expect(await start(single, newId('acc'))).toMatchObject({ data: { reason: 'full' } });

    const reset = { name, reason: 'incident over' };
    const resetPreview = await mod.actions.resetLimit.runPreview(reset, NO_CTX);
    const back = orThrow(await mod.actions.resetLimit.runExecute(reset, NO_CTX, permit(resetPreview.revision)));
    expect(back).toMatchObject({ override: { total: null, perKey: null }, keys: [] });
    orThrow(await start(single, newId('acc')));
    // The key override went with the reset, so the account is back to one run.
    expect(await start(single, account)).toMatchObject({ data: { reason: 'full' } });
  });

  it('an operator change since the preview voids a limit approval, but runs taking slots do not', async () => {
    const mod = module();
    const pause = { name: 'test.fv.spare', reason: 'incident' };
    const preview = await mod.actions.pauseLimit.runPreview(pause, NO_CTX);
    // A run takes a slot: the limit is busier, but nobody changed it.
    await startParked(spared);
    const kept = await mod.actions.pauseLimit.runPreview(pause, NO_CTX);
    expect(kept.revision).toBe(preview.revision);

    orThrow(await journal.limits.override(db, { name: 'test.fv.spare', total: 3 }, ops));
    await expect(mod.actions.pauseLimit.runExecute(pause, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: CODES.staleRevision,
      status: 409,
    });
    expect(orThrow(await journal.limits.get(db, 'test.fv.spare')).paused).toBe(false);
  });

  it('an unknown limit and an override of a limit that caps nothing are refused before approval', async () => {
    const mod = module();
    await expect(mod.reads.limit.run({ name: 'test.fv.nope' }, NO_CTX)).rejects.toMatchObject({ status: 404 });
    await expect(
      mod.actions.pauseLimit.runPreview({ name: 'test.fv.nope', reason: 'x' }, NO_CTX),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      mod.actions.overrideLimit.runPreview({ name: 'workflow/test.fv.parked', total: 2, reason: 'x' }, NO_CTX),
    ).rejects.toMatchObject({ status: 400 });
    expect(await mod.reads.limit.run({ name: 'workflow/test.fv.parked' }, NO_CTX)).toMatchObject({
      code: { total: null, perKey: null },
      workflows: ['test.fv.parked'],
    });
  });
});

describe('run reads', () => {
  it('show the batch, timing and overrides of a run, and filter by batch and start time', async () => {
    const mod = module();
    const before = new Date().toISOString();
    const batch = orThrow(
      await journal.run(
        db,
        parked.startBatch,
        { items: [{ input: { account: newId('acc') } }, { input: { account: newId('acc') }, scope: 'ten_a' }] },
        caller,
      ),
    );
    const page = await mod.reads.runs.run({ batchId: batch.batchId, from: before, limit: 50 }, NO_CTX);
    expect(page.runs).toHaveLength(2);
    expect(page.runs.every(run => run.batchId === batch.batchId)).toBe(true);
    const scoped = await mod.reads.runs.run({ batchId: batch.batchId, scope: 'ten_a', limit: 50 }, NO_CTX);
    expect(scoped.runs).toHaveLength(1);
    expect(await mod.reads.runs.run({ batchId: batch.batchId, to: before, limit: 50 }, NO_CTX)).toMatchObject({
      runs: [],
    });

    const runId = orThrow(
      await journal.run(
        db,
        quick.start,
        { input: { account: newId('acc') }, delay: '1h', ttl: '2h', priority: 3, maxAttempts: 4, timeout: '1m' },
        caller,
      ),
    ).runId;
    const { run } = await runOf(runId);
    expect(run).toMatchObject({ priority: 3, maxAttempts: 4, stepTimeoutMs: 60_000, replayOf: null, batchId: null });
    expect(run.startAt).not.toBeNull();
    expect(run.delayedUntil).toBe(run.startAt);
    expect(Date.parse(run.ttlAt ?? '')).toBe(Date.parse(run.startAt ?? '') + 2 * 3_600_000);
  });
});
