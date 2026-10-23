/**
 * The start gate of `concurrency: { key, limit, onBusy }` on PGlite. The gate is what lets an app say "one sync per
 * account at a time" or "at most two imports per workspace": a start over the limit must never create a run, and a
 * run that ends must free its slot. Races between two real connections are in `runner.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { isFailure, orThrow } from '@arki/failure';

import { WorkflowBusy } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

const accountInput = z.object({ account: z.string(), n: z.int() });

/** One sync per account: a second start for a busy account is refused. */
const sync = j
  .workflow('test.sync', {
    version: 1,
    input: accountInput,
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'refuse' },
  })
  .step('pull', ({ input }) => input.n)
  .finish();

/** One rebuild per account, and a second start gets the running one back. */
const rebuild = j
  .workflow('test.rebuild', {
    version: 1,
    input: accountInput,
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'join' },
  })
  .step('build', ({ input }) => input.n)
  .finish();

/** Two imports per account at a time. */
const imports = j
  .workflow('test.imports', {
    version: 1,
    input: accountInput,
    concurrency: { key: ({ account }) => account, limit: 2, onBusy: 'refuse' },
  })
  .step('load', ({ input }) => input.n)
  .finish();

/** A key function with a bug: it returns an empty key. */
const badKey = j
  .workflow('test.bad-key', {
    version: 1,
    input: accountInput,
    concurrency: { key: () => '', limit: 1, onBusy: 'refuse' },
  })
  .step('noop', () => null)
  .finish();

/** A reindex that parks until it is told to go, so it holds its key for as long as a test needs. */
const reindex = j
  .workflow('test.reindex', {
    version: 1,
    input: accountInput,
    concurrency: { key: ({ account }) => account, limit: 1, onBusy: 'join' },
  })
  .waitFor('go', { signal: 'go', schema: z.object({}) })
  .finish();

/** A parent whose child is gated by the reindex key: a busy child cannot join, so the parent's node fails. */
const nightly = j
  .workflow('test.nightly', { version: 1, input: accountInput })
  .child('reindex', reindex, { input: ({ input }) => input })
  .finish();

const journal = j.compose({ workflows: [sync, rebuild, imports, badKey, reindex, nightly], workflowMeta });

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

const unfinished = async (name: string, key: string) =>
  db
    .select({ id: tables.workflowRuns.id })
    .from(tables.workflowRuns)
    .where(
      and(
        eq(tables.workflowRuns.name, name),
        eq(tables.workflowRuns.concurrencyKey, key),
        isNull(tables.workflowRuns.finishedAt),
      ),
    );
const stateOf = async (id: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row?.state;
};

describe('concurrency: refuse', () => {
  it('a second start for a busy key is refused and creates no run, so two syncs of one account never overlap', async () => {
    const account = newId('acc');
    const first = newId('sync');
    expect(await journal.run(db, sync.start, { input: { account, n: 1 }, id: first }, caller)).toEqual({
      runId: first,
    });
    const second = newId('sync');
    const refused = await journal.run(db, sync.start, { input: { account, n: 2 }, id: second }, caller);
    expect(WorkflowBusy.is(refused)).toBe(true);
    if (!WorkflowBusy.is(refused)) return;
    expect(refused.data).toMatchObject({ name: 'test.sync', key: account, limit: 1, running: [first] });
    expect(await stateOf(second)).toBeUndefined();
    expect(await unfinished('test.sync', account)).toEqual([{ id: first }]);
  });

  it('the key is per value: another account starts at once', async () => {
    const busy = newId('acc');
    const free = newId('acc');
    orThrow(await journal.run(db, sync.start, { input: { account: busy, n: 1 } }, caller));
    expect(isFailure(await journal.run(db, sync.start, { input: { account: free, n: 1 } }, caller))).toBe(false);
  });

  it('a run that finishes frees its slot, so the next start for that key goes through', async () => {
    const account = newId('acc');
    orThrow(await journal.run(db, sync.start, { input: { account, n: 1 } }, caller));
    await settle();
    expect(await unfinished('test.sync', account)).toEqual([]);
    expect(isFailure(await journal.run(db, sync.start, { input: { account, n: 2 } }, caller))).toBe(false);
  });

  it('the same start again (same id, same input) is the same run, not a busy key', async () => {
    const account = newId('acc');
    const id = newId('sync');
    orThrow(await journal.run(db, sync.start, { input: { account, n: 1 }, id }, caller));
    expect(await journal.run(db, sync.start, { input: { account, n: 1 }, id }, caller)).toEqual({ runId: id });
  });
});

describe('concurrency: join', () => {
  it('a start for a busy key answers the running run, so a caller waits on the rebuild already under way', async () => {
    const account = newId('acc');
    const first = newId('rebuild');
    orThrow(await journal.run(db, rebuild.start, { input: { account, n: 1 }, id: first }, caller));
    const second = newId('rebuild');
    expect(await journal.run(db, rebuild.start, { input: { account, n: 9 }, id: second }, caller)).toEqual({
      runId: first,
    });
    expect(await stateOf(second)).toBeUndefined();
  });

  it('a child cannot join a run another parent started: the child start is refused and the parent node fails', async () => {
    const account = newId('acc');
    const held = newId('reindex');
    orThrow(await journal.run(db, reindex.start, { input: { account, n: 1 }, id: held }, caller));
    const parent = newId('nightly');
    orThrow(await journal.run(db, nightly.start, { input: { account, n: 2 }, id: parent }, caller));
    await settle();
    expect(await stateOf(held)).toBe('parked');
    expect(await stateOf(`${parent}/reindex`)).toBeUndefined();
    const [node] = await db
      .select({ status: tables.workflowSteps.status })
      .from(tables.workflowSteps)
      .where(and(eq(tables.workflowSteps.runId, parent), eq(tables.workflowSteps.path, 'reindex')));
    expect(node?.status).toBe('failed');
  });
});

describe('concurrency: limit above one', () => {
  it('a limit of two lets two runs of one key start and refuses the third', async () => {
    const account = newId('acc');
    orThrow(await journal.run(db, imports.start, { input: { account, n: 1 } }, caller));
    orThrow(await journal.run(db, imports.start, { input: { account, n: 2 } }, caller));
    const third = await journal.run(db, imports.start, { input: { account, n: 3 } }, caller);
    expect(WorkflowBusy.is(third)).toBe(true);
    if (WorkflowBusy.is(third)) expect(third.data.running).toHaveLength(2);
  });
});

describe('concurrency: key function', () => {
  it('an empty key is a bug in the definition: the start is a defect naming BAD_DEFINITION, so it never gates on a meaningless key', async () => {
    const id = newId('bad');
    const started = await journal.run(db, badKey.start, { input: { account: 'a', n: 1 }, id }, caller);
    expect(started).toMatchObject({ code: TransactionDefect.code, cause: { code: 'BAD_DEFINITION' } });
    expect(await stateOf(id)).toBeUndefined();
  });
});
