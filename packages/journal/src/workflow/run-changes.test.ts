/**
 * Changing a run's metadata and tags after its start, on PGlite: `ctx.metadata` and `ctx.tags` in a step or an undo,
 * and the operator verbs `journal.workflows.setMetadata` and `addTags`. A run reports progress through its metadata,
 * so a reader must see each change while the step still runs, a refused change must not fail the step that tried it,
 * and the row must stay what its events say, so a replay rebuilds it.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { isFailure, orThrow } from '@arki/failure';

import type { EffectContext } from '../types.js';
import { CommandConflict, CommandInvalid, CommandNotFound } from '../errors.js';
import { j, order, orderId, OrderPlaced, orders, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { workflowMachine } from './machine.js';
import { RUN_FIELD_LIMITS } from './run-fields.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const operator = { actor: 'usr_ops', reason: 'fix the label', executionId: 'exe_1' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};
/** A promise a test settles by hand, to hold a step body at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}
let reached = gate();
let hold = gate();

/** Reports progress, then waits for the test before it removes its `phase`. */
const progress = j
  .workflow('test.changes-progress', { version: 1, input: z.object({}) })
  .step('work', async ({ metadata, tags }) => {
    orThrow(await metadata.set({ phase: 'copying' }));
    orThrow(await metadata.increment('done'));
    orThrow(await metadata.increment('done', 2));
    orThrow(await metadata.append('log', 'a'));
    orThrow(await metadata.append('log', { at: 2 }));
    orThrow(await tags.add('busy', 'busy', 'eu'));
    reached.open();
    await hold.opened;
    return orThrow(await metadata.remove('phase')).metadata;
  })
  .finish();

/** Every change this step tries is refused; the step still returns, and records what it was told. */
const refused = j
  .workflow('test.changes-refused', { version: 1, input: z.object({}) })
  .step('try', async ({ metadata, tags }) => {
    const outcomes = [
      await metadata.increment('label'),
      await metadata.append('count', 1),
      await metadata.set({ big: 'x'.repeat(RUN_FIELD_LIMITS.metadataBytes) }),
      await tags.add('t9', 'extra1', 'extra2'),
    ];
    return outcomes.map(outcome => (isFailure(outcome) ? outcome.code : 'ok'));
  })
  .finish();

/** Parks on a signal, so an operator can change it while it waits; its undo writes metadata while it compensates. */
/** The calls a step made without awaiting them, so the test can wait for them after the step settled. */
const unawaited: Promise<unknown>[] = [];
/** Reports progress without awaiting it, as a loop of work does; every other call is refused (`label` is text). */
const fireAndForget = j
  .workflow('test.changes-unawaited', { version: 1, input: z.object({}) })
  .step('work', ({ metadata }) => {
    for (let n = 0; n < 5; n++) {
      unawaited.push(metadata.increment('done'), metadata.increment('label'));
    }
    return 'done';
  })
  .finish();

/** Changes the `reserve` step keeps for after its attempt ended, one per attempt. */
const lates: (() => Promise<unknown>)[] = [];

const parked = j
  .workflow('test.changes-parked', { version: 1, input: z.object({}) })
  .step(
    'reserve',
    ({ metadata }) => {
      lates.push(() => metadata.set({ late: true }));
      return 'reserved';
    },
    {
      undo: async ({ metadata }) => {
        orThrow(await metadata.set({ undone: true }));
      },
    },
  )
  .waitFor('confirm', { signal: 'confirm', schema: z.object({}) })
  .finish();

/** The contexts an app effect was given, to check it never gets the steps' runners. */
const appContexts: EffectContext<unknown>[] = [];
const appEffect = j.effect('test.changes-app', order, {
  OrderPlaced: (_event, ctx) => {
    appContexts.push(ctx);
  },
});

const journal = j.compose({
  workflows: [progress, refused, fireAndForget, parked],
  workflowMeta,
  effects: [appEffect],
});
/** The run entity's reducers, built again for `verify`: the same definitions the runner writes with. */
const runEntity = workflowMachine(j, tables).run;

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, orders }));
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
  if (row === undefined) throw new Error(`no run ${id}`);
  return row;
};
const eventsOf = (id: string) => journal.workflows.history(db, id, { limit: 200 }).then(page => page.events);
/** The events that changed the run's metadata or tags, oldest first. */
const changesOf = (id: string) =>
  eventsOf(id).then(events => events.filter(event => event.type === 'MetadataChanged' || event.type === 'RunTagged'));
const start = async <Def extends typeof progress | typeof refused | typeof fireAndForget | typeof parked>(
  def: Def,
  fields: { readonly tags?: readonly string[]; readonly metadata?: Readonly<Record<string, unknown>> } = {},
) => {
  const id = newId('run');
  orThrow(await journal.run(db, def.start, { input: {}, id, ...fields }, caller));
  return id;
};

describe('ctx.metadata and ctx.tags in a step', () => {
  it('each change commits at once, so a reader sees the progress while the step still runs', async () => {
    reached = gate();
    hold = gate();
    const id = await start(progress);
    const draining = settle();
    await reached.opened;

    const during = await rowOf(id);
    expect(during.state).toBe('running');
    expect(during.metadata).toEqual({ phase: 'copying', done: 3, log: ['a', { at: 2 }] });
    // `busy` was given twice: it is kept once.
    expect(during.tags).toEqual(['busy', 'eu']);

    hold.open();
    await draining;
    const after = await rowOf(id);
    expect(after.state).toBe('completed');
    expect(after.metadata).toEqual({ done: 3, log: ['a', { at: 2 }] });
    expect(after.output).toEqual({ done: 3, log: ['a', { at: 2 }] });
  });

  it('every change is one event in the run history, and a replay of the history rebuilds the row', async () => {
    reached = gate();
    hold = gate();
    const id = await start(progress, { metadata: { owner: 'usr_1' } });
    hold.open();
    await settle();

    const changes = await changesOf(id);
    expect(changes.map(event => event.data)).toEqual([
      { change: { kind: 'set', patch: { phase: 'copying' } }, at: expect.any(String) },
      { change: { kind: 'increment', key: 'done', by: 1 }, at: expect.any(String) },
      { change: { kind: 'increment', key: 'done', by: 2 }, at: expect.any(String) },
      { change: { kind: 'append', key: 'log', value: 'a' }, at: expect.any(String) },
      { change: { kind: 'append', key: 'log', value: { at: 2 } }, at: expect.any(String) },
      { tags: ['busy', 'eu'], at: expect.any(String) },
      { change: { kind: 'remove', key: 'phase' }, at: expect.any(String) },
    ]);
    const row = await rowOf(id);
    expect(row.metadata).toEqual({ owner: 'usr_1', done: 3, log: ['a', { at: 2 }] });
    expect(await journal.verify(db, runEntity, id)).toEqual({ ok: true });
  });

  it('a refused change is only the value the call returns: the step completes and nothing changes', async () => {
    const nine = Array.from({ length: RUN_FIELD_LIMITS.tags - 1 }, (_, n) => `t${n + 1}`);
    const id = await start(refused, { tags: nine, metadata: { label: 'x', count: 1 } });
    await settle();

    const row = await rowOf(id);
    // A watched refusal would turn the step's success into a failure, and the run would end failed.
    expect(row.state).toBe('completed');
    expect(row.output).toEqual([CommandInvalid.code, CommandInvalid.code, CommandInvalid.code, CommandInvalid.code]);
    expect(row.metadata).toEqual({ label: 'x', count: 1 });
    expect(row.tags).toEqual(nine);
    // The step's job ended well: a refusal its body never accepted would have made it dead, with that refusal.
    const dead = await db
      .select({ lastError: tables.jobs.lastError })
      .from(tables.jobs)
      .where(and(eq(tables.jobs.runId, id), isNotNull(tables.jobs.deadAt)));
    expect(dead).toEqual([]);
    const changes = await changesOf(id);
    expect(changes).toEqual([]);
  });

  it('an undo may change metadata while the run compensates', async () => {
    const id = await start(parked);
    await settle();
    const waiting = await rowOf(id);
    expect(waiting.state).toBe('parked');
    orThrow(await journal.run(db, parked.cancel, { runId: id, reason: 'stop' }, caller));
    await settle();

    const row = await rowOf(id);
    expect(row.state).toBe('cancelled');
    expect(row.metadata).toEqual({ undone: true });
  });
});

describe('ctx.metadata and ctx.tags without await', () => {
  it('calls a step does not await never reject and never change its outcome, refused or late', async () => {
    unawaited.length = 0;
    const id = await start(fireAndForget, { metadata: { label: 'x' } });
    await settle();
    // Every call settles to a value: a rejection here, or an unhandled one, fails the test.
    const outcomes = await Promise.all(unawaited);

    const row = await rowOf(id);
    expect(row.state).toBe('completed');
    expect(row.output).toBe('done');
    const dead = await db
      .select({ lastError: tables.jobs.lastError })
      .from(tables.jobs)
      .where(and(eq(tables.jobs.runId, id), isNotNull(tables.jobs.deadAt)));
    expect(dead).toEqual([]);
    // Each increment of `label` was refused: wrong type while the run ran, or finished once it completed.
    const refusedLabels = outcomes.filter((_, at) => at % 2 === 1);
    expect(refusedLabels.every(outcome => CommandInvalid.is(outcome) || CommandConflict.is(outcome))).toBe(true);
    // Each increment of `done` that committed is one event, and the row agrees with the events.
    const changes = await changesOf(id);
    const applied = changes.length;
    expect(row.metadata).toEqual(applied === 0 ? { label: 'x' } : { label: 'x', done: applied });
    expect(await journal.verify(db, runEntity, id)).toEqual({ ok: true });
  });

  it('a change from an attempt that has ended writes nothing: the fence holds, and the call answers with a failure', async () => {
    lates.length = 0;
    const id = await start(parked);
    await settle();
    const waiting = await rowOf(id);
    expect(waiting.state).toBe('parked');
    const late = lates.at(-1);
    if (late === undefined) throw new Error('the reserve step did not run');

    // The run is still open, so only the closed attempt can refuse it.
    const outcome = await late();
    expect(TransactionDefect.is(outcome)).toBe(true);
    expect(outcome).toMatchObject({ cause: { code: 'LEASE_LOST' } });
    const row = await rowOf(id);
    expect(row.metadata).toEqual({});
    expect(await changesOf(id)).toEqual([]);
  });
});

describe('the unwatched runner belongs to the journal', () => {
  it("an app effect's context has no command runner at all: no run, no accept, no runUnwatched, no hidden key", async () => {
    appContexts.length = 0;
    const placed = await db.transaction(tx =>
      journal.write(tx, order, orderId(++counter), {
        meta: caller,
        events: () => [OrderPlaced({ customerId: 'cus_1', total: 100 })],
      }),
    );
    orThrow(placed);
    await settle();

    expect(appContexts).toHaveLength(1);
    const [context] = appContexts;
    expect(context).not.toHaveProperty('run');
    expect(context).not.toHaveProperty('accept');
    expect(context).not.toHaveProperty('runUnwatched');
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
  });
});

describe('journal.workflows.setMetadata and addTags', () => {
  it('change a parked run and record the operator on the event', async () => {
    const id = await start(parked, { tags: ['nightly'], metadata: { label: 'wrong' } });
    await settle();

    const set = orThrow(
      await journal.workflows.setMetadata(
        db,
        { runId: id, change: { kind: 'set', patch: { label: 'right' } } },
        operator,
      ),
    );
    expect(set.metadata).toEqual({ label: 'right' });
    const tagged = orThrow(await journal.workflows.addTags(db, { runId: id, tags: ['nightly', 'audited'] }, operator));
    expect(tagged.tags).toEqual(['nightly', 'audited']);

    const row = await rowOf(id);
    expect(row.state).toBe('parked');
    expect(row.metadata).toEqual({ label: 'right' });
    expect(row.tags).toEqual(['nightly', 'audited']);
    const changes = await changesOf(id);
    expect(changes.map(event => event.data)).toEqual([
      {
        change: { kind: 'set', patch: { label: 'right' } },
        at: expect.any(String),
        actorId: 'usr_ops',
        reason: 'fix the label',
        executionId: 'exe_1',
      },
      { tags: ['audited'], at: expect.any(String), actorId: 'usr_ops', reason: 'fix the label', executionId: 'exe_1' },
    ]);
    expect(await journal.verify(db, runEntity, id)).toEqual({ ok: true });
  });

  it('a tag the run has already writes no event', async () => {
    const id = await start(parked, { tags: ['nightly'] });
    await settle();
    const before = await eventsOf(id);

    expect(orThrow(await journal.workflows.addTags(db, { runId: id, tags: ['nightly'] }, operator)).tags).toEqual([
      'nightly',
    ]);
    expect(await eventsOf(id)).toEqual(before);
  });

  it('refuse a finished run with CommandConflict and an unknown run with CommandNotFound', async () => {
    const id = await start(refused);
    await settle();
    const finished = await rowOf(id);
    expect(finished.state).toBe('completed');

    const change = { kind: 'set', patch: { late: true } } as const;
    expect(CommandConflict.is(await journal.workflows.setMetadata(db, { runId: id, change }, operator))).toBe(true);
    expect(CommandConflict.is(await journal.workflows.addTags(db, { runId: id, tags: ['late'] }, operator))).toBe(true);
    const after = await rowOf(id);
    expect(after.metadata).toEqual(finished.metadata);
    expect(after.version).toBe(finished.version);
    expect(CommandNotFound.is(await journal.workflows.setMetadata(db, { runId: 'run_none', change }, operator))).toBe(
      true,
    );
  });

  it('refuse a change that is not JSON, or a value of the wrong type, with CommandInvalid', async () => {
    const id = await start(parked, { metadata: { label: 'x' } });
    await settle();

    const notJson = { kind: 'set', patch: { when: new Date(0) } } as const;
    expect(CommandInvalid.is(await journal.workflows.setMetadata(db, { runId: id, change: notJson }, operator))).toBe(
      true,
    );
    const wrongType = { kind: 'increment', key: 'label', by: 1 } as const;
    expect(CommandInvalid.is(await journal.workflows.setMetadata(db, { runId: id, change: wrongType }, operator))).toBe(
      true,
    );
    const row = await rowOf(id);
    expect(row.metadata).toEqual({ label: 'x' });
  });

  it('need an actor, like every operator verb', async () => {
    const id = await start(parked);
    await settle();
    await expect(journal.workflows.addTags(db, { runId: id, tags: ['x'] }, { actor: ' ' })).resolves.toMatchObject({
      code: TransactionDefect.code,
      cause: { code: 'BAD_ARGUMENT' },
    });
    const row = await rowOf(id);
    expect(row.tags).toEqual([]);
  });
});
