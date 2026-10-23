/**
 * `journal.workflows.replay` on PGlite. An operator replays a run after fixing a bug: a new run of the same workflow,
 * at the code deployed now, with the old run's input and fields. The old run must stay as it was (it is the record of
 * what happened), the new one must say where it came from and who asked, and it must obey the same rules as any
 * start: the newest input schema and the concurrency gate.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, orThrow } from '@arki/failure';

import { CommandNotFound, WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const operator = { actor: 'usr_ops', reason: 'rerun after the fix' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** One sync per account, parked until it is told to go, so a run holds its key for as long as a test needs. */
const sync = j
  .workflow('test.sync', {
    version: 1,
    input: z.object({ account: z.string(), n: z.int() }),
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'refuse' },
  })
  .waitFor('go', { signal: 'go', schema: z.object({}) })
  .step('done', ({ input }) => input.n)
  .finish();

/** Two versions of one task: v2 takes only n of 0 or more, and multiplies by 10, so a result tells the version. */
const reportV1 = j.task('test.report', { version: 1, input: z.object({ n: z.int() }) }, ({ input }) => input.n);
const reportV2 = j.task(
  'test.report',
  { version: 2, input: z.object({ n: z.int().min(0) }) },
  ({ input }) => input.n * 10,
);

/** A parent with a child task: a replay starts the parent again, and the new parent starts its own child. */
const leaf = j.task('test.leaf', { version: 1, input: z.object({ n: z.int() }) }, ({ input }) => input.n + 1);
const tree = j
  .workflow('test.tree', { version: 1, input: z.object({ n: z.int() }) })
  .child('leaf', leaf, { input: ({ input }) => input })
  .finish();

const journal = j.compose({ workflows: [sync, reportV1, reportV2, leaf, tree], workflowMeta });

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
const go = (runId: string) =>
  journal.run(db, sync.signal('go'), { runId, deliveryId: newId('go'), payload: {} }, caller);

/** A sync that has completed, started with every run field. */
async function completedSync(account: string) {
  const id = newId('sync');
  const fields = { scope: 'tenant_1', tags: ['nightly', `account:${account}`], metadata: { source: 'cron' } };
  orThrow(await journal.run(db, sync.start, { input: { account, n: 7 }, id, ...fields }, caller));
  orThrow(await go(id));
  await settle();
  expect(await rowOf(id)).toMatchObject({ state: 'completed' });
  return { id, fields };
}

describe('journal.workflows.replay', () => {
  it("starts a new run with the old run's input and fields, says it replays it, and leaves the old run alone", async () => {
    const account = newId('acc');
    const { id: old, fields } = await completedSync(account);
    const before = await rowOf(old);
    const replayed = orThrow(await journal.workflows.replay(db, { runId: old }, operator));
    if (!('runId' in replayed)) throw new Error('the replay was refused');
    expect(replayed.runId).not.toBe(old);
    expect(await rowOf(replayed.runId)).toMatchObject({
      name: 'test.sync',
      state: 'running',
      input: { account, n: 7 },
      ...fields,
      replayOf: old,
      batchId: null,
    });
    // Why: the old run is the record of what happened; a replay adds a run, it never rewrites one.
    expect(await rowOf(old)).toEqual(before);
    // The operator who asked is on the new run's first event, as on every operator verb.
    const { events } = await journal.workflows.history(db, replayed.runId);
    expect(events[0]).toMatchObject({
      type: 'RunStarted',
      data: { replayOf: old, actorId: operator.actor, reason: operator.reason },
    });
  });

  it('replaces what overrides gives and keeps the rest', async () => {
    const { id: old, fields } = await completedSync(newId('acc'));
    const account = newId('acc');
    const replayed = orThrow(
      await journal.workflows.replay(
        db,
        { runId: old, overrides: { input: { account, n: 8 }, tags: ['manual'] } },
        operator,
      ),
    );
    if (!('runId' in replayed)) throw new Error('the replay was refused');
    expect(await rowOf(replayed.runId)).toMatchObject({
      input: { account, n: 8 },
      tags: ['manual'],
      scope: fields.scope,
      metadata: fields.metadata,
    });
  });

  it('goes through the concurrency gate: replaying a run that still holds its key is busy', async () => {
    const account = newId('acc');
    const holding = newId('sync');
    orThrow(await journal.run(db, sync.start, { input: { account, n: 1 }, id: holding }, caller));
    await settle();
    expect(await rowOf(holding)).toMatchObject({ state: 'parked' });
    const busy = await journal.workflows.replay(db, { runId: holding }, operator);
    // Why: a replay that skipped the gate would let two syncs of one account run at once.
    expect(WorkflowBusy.is(busy)).toBe(true);
    // An unfinished run replays too, once the new run has a key of its own.
    const moved = orThrow(
      await journal.workflows.replay(
        db,
        { runId: holding, overrides: { input: { account: newId('acc'), n: 1 } } },
        operator,
      ),
    );
    expect(moved).toEqual({ runId: expect.any(String) });
  });

  it('starts the newest registered version, and refuses an input the newest input schema no longer takes', async () => {
    const id = newId('report');
    orThrow(await journal.run(db, reportV2.start, { input: { n: 3 }, id }, caller));
    await settle();
    // Stands in for a run started on v1, before v2 was deployed: a v1 run can no longer be started now.
    await db
      .update(tables.workflowRuns)
      .set({ workflowVersion: 1, input: { n: 4 } })
      .where(eq(tables.workflowRuns.id, id));
    const replayed = orThrow(await journal.workflows.replay(db, { runId: id }, operator));
    if (!('runId' in replayed)) throw new Error('the replay was refused');
    await settle();
    expect(await rowOf(replayed.runId)).toMatchObject({ workflowVersion: 2, state: 'completed', output: 40 });

    await db
      .update(tables.workflowRuns)
      .set({ input: { n: -1 } })
      .where(eq(tables.workflowRuns.id, id));
    const refused = await journal.workflows.replay(db, { runId: id }, operator);
    expect(InvalidInput.is(refused), 'v2 takes only n >= 0').toBe(true);
  });

  it('does not copy the children: the new parent starts a child of its own', async () => {
    const id = newId('tree');
    orThrow(await journal.run(db, tree.start, { input: { n: 1 }, id }, caller));
    await settle();
    const replayed = orThrow(await journal.workflows.replay(db, { runId: id }, operator));
    if (!('runId' in replayed)) throw new Error('the replay was refused');
    await settle();
    expect(await rowOf(replayed.runId)).toMatchObject({ state: 'completed', output: 2 });
    const childrenOf = (parentId: string) =>
      db
        .select({ id: tables.workflowRuns.id, rootId: tables.workflowRuns.rootId })
        .from(tables.workflowRuns)
        .where(eq(tables.workflowRuns.parentId, parentId));
    const [oldChild] = await childrenOf(id);
    const [newChild] = await childrenOf(replayed.runId);
    expect(newChild?.rootId).toBe(replayed.runId);
    expect(newChild?.id).not.toBe(oldChild?.id);
    expect(await childrenOf(id)).toHaveLength(1);
  });

  it('refuses an unknown run with CommandNotFound', async () => {
    expect(CommandNotFound.is(await journal.workflows.replay(db, { runId: 'wfr_missing' }, operator))).toBe(true);
  });
});
