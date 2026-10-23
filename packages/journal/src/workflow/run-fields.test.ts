/**
 * The run fields `def.start` takes, on PGlite: `scope` (the tenant a run belongs to), `tags`, `metadata`, and the
 * `rootId` of a run tree. Later slices count, stream and authorize by them, so a child must carry its tree's scope
 * and root, and a start with fields over the limits must create no run.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, orThrow } from '@arki/failure';

import { CommandConflict, CommandInvalid } from '../errors.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { RUN_FIELD_LIMITS } from './run-fields.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

const nInput = z.object({ n: z.int() });

const leaf = j
  .workflow('test.fields-leaf', { version: 1, input: nInput })
  .step('double', ({ input }) => input.n * 2)
  .finish();

const middle = j
  .workflow('test.fields-middle', { version: 1, input: nInput })
  .child('kid', leaf, { input: ({ input }) => input })
  .finish();

/** Three levels: top, its child, and a grandchild. */
const top = j
  .workflow('test.fields-top', { version: 1, input: nInput })
  .child('mid', middle, { input: ({ input }) => input })
  .finish();

const fan = j
  .workflow('test.fields-fan', { version: 1, input: z.object({ ns: z.array(z.int()) }) })
  .map('each', leaf, { items: ({ input }) => input.ns, input: (_ctx, n) => ({ n }) })
  .finish();

const journal = j.compose({ workflows: [leaf, middle, top, fan], workflowMeta });

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
const childrenOf = async (parentId: string) =>
  db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.parentId, parentId));
const idsOf = (page: { readonly runs: readonly { readonly id: string }[] }) => page.runs.map(run => run.id).toSorted();

describe('run fields: stored at start', () => {
  it('scope, tags and metadata are stored and read back, so an app can find and describe its runs', async () => {
    const id = newId('run');
    const scope = newId('tenant');
    const started = await journal.run(
      db,
      leaf.start,
      { input: { n: 1 }, id, scope, tags: ['nightly', 'eu'], metadata: { requestedBy: 'usr_1', batch: 3 } },
      caller,
    );
    expect(started).toEqual({ runId: id });
    const detail = await journal.workflows.run(db, id);
    expect(detail?.run).toMatchObject({
      scope,
      tags: ['nightly', 'eu'],
      metadata: { requestedBy: 'usr_1', batch: 3 },
      rootId: null,
    });
    const page = await journal.workflows.runs(db, { scope });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({ id, scope, tags: ['nightly', 'eu'], rootId: null });
  });

  it('a start without fields gets no scope, no tags and empty metadata, so old callers keep working', async () => {
    const id = newId('run');
    orThrow(await journal.run(db, leaf.start, { input: { n: 1 }, id }, caller));
    expect(await rowOf(id)).toMatchObject({ scope: null, tags: [], metadata: {}, rootId: null });
  });

  it('the same id started again under another scope is a conflict, so one tenant never gets another tenant run', async () => {
    const id = newId('run');
    orThrow(await journal.run(db, leaf.start, { input: { n: 1 }, id, scope: 'tenant_a' }, caller));
    expect(await journal.run(db, leaf.start, { input: { n: 1 }, id, scope: 'tenant_a' }, caller)).toEqual({
      runId: id,
    });
    const other = await journal.run(db, leaf.start, { input: { n: 1 }, id, scope: 'tenant_b' }, caller);
    expect(CommandConflict.is(other)).toBe(true);
  });
});

describe('run fields: children', () => {
  it('a child and a grandchild take the top run scope and its id as rootId, but no tags or metadata, so a tree is one tenant', async () => {
    const id = newId('top');
    const scope = newId('tenant');
    orThrow(await journal.run(db, top.start, { input: { n: 2 }, id, scope, tags: ['t'], metadata: { a: 1 } }, caller));
    await settle();
    const [mid] = await childrenOf(id);
    expect(mid).toMatchObject({ parentId: id, scope, rootId: id, tags: [], metadata: {} });
    if (mid === undefined) return;
    const [grandchild] = await childrenOf(mid.id);
    expect(grandchild).toMatchObject({ parentId: mid.id, scope, rootId: id, tags: [], metadata: {} });
    expect(await rowOf(id)).toMatchObject({ state: 'completed', rootId: null });
    if (grandchild === undefined) return;
    expect(idsOf(await journal.workflows.runs(db, { rootId: id }))).toEqual([mid.id, grandchild.id].toSorted());
  });

  it('every child of a map gets the root and the scope, so a fan-out stays in its tree', async () => {
    const id = newId('fan');
    orThrow(await journal.run(db, fan.start, { input: { ns: [1, 2, 3] }, id, scope: 'tenant_fan' }, caller));
    await settle();
    const kids = await childrenOf(id);
    expect(kids).toHaveLength(3);
    for (const kid of kids) expect(kid).toMatchObject({ scope: 'tenant_fan', rootId: id });
  });

  it('a top run without a scope gives its children none', async () => {
    const id = newId('top');
    orThrow(await journal.run(db, middle.start, { input: { n: 1 }, id }, caller));
    await settle();
    const [kid] = await childrenOf(id);
    expect(kid).toMatchObject({ scope: null, rootId: id });
  });
});

describe('run fields: the runs filter', () => {
  it('filters by tag, scope and start time, so an operator can find one tenant runs of a period', async () => {
    const scope = newId('tenant');
    const first = newId('run');
    orThrow(await journal.run(db, leaf.start, { input: { n: 1 }, id: first, scope, tags: ['a', 'shared'] }, caller));
    await new Promise(resolve => setTimeout(resolve, 5));
    const between = new Date();
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = newId('run');
    orThrow(await journal.run(db, leaf.start, { input: { n: 1 }, id: second, scope, tags: ['b', 'shared'] }, caller));
    const elsewhere = newId('run');
    orThrow(await journal.run(db, leaf.start, { input: { n: 1 }, id: elsewhere, tags: ['a'] }, caller));

    expect(idsOf(await journal.workflows.runs(db, { scope }))).toEqual([first, second].toSorted());
    expect(idsOf(await journal.workflows.runs(db, { scope, tag: 'a' }))).toEqual([first]);
    expect(idsOf(await journal.workflows.runs(db, { scope, tag: 'shared' }))).toEqual([first, second].toSorted());
    expect(idsOf(await journal.workflows.runs(db, { scope, tag: 'missing' }))).toEqual([]);
    expect(idsOf(await journal.workflows.runs(db, { scope, from: between }))).toEqual([second]);
    expect(idsOf(await journal.workflows.runs(db, { scope, to: between }))).toEqual([first]);
    expect(idsOf(await journal.workflows.runs(db, { tag: 'a' }))).toContain(elsewhere);
  });
});

/** Starts a leaf run with `fields`, and reads back whether a row was written. */
const refusedStart = async (fields: Record<string, unknown>) => {
  const id = newId('refused');
  const outcome = await journal.run(db, leaf.start, { input: { n: 1 }, id, ...fields }, caller);
  return { outcome, row: await rowOf(id) };
};
const refusedOutcome = async (fields: Record<string, unknown>) => {
  const { outcome } = await refusedStart(fields);
  return outcome;
};

describe('run fields: refusals', () => {
  it('the limits themselves are allowed, so a caller can use all of them', async () => {
    const tags = Array.from({ length: RUN_FIELD_LIMITS.tags }, (_, index) =>
      `${index}`.padEnd(RUN_FIELD_LIMITS.tag, 'x'),
    );
    const { outcome, row } = await refusedStart({ tags, scope: 's'.repeat(RUN_FIELD_LIMITS.scope) });
    expect(CommandInvalid.is(outcome) || InvalidInput.is(outcome)).toBe(false);
    expect(row?.tags).toEqual(tags);
  });

  it('11 tags are refused and no run starts, so the GIN index and the filters stay small', async () => {
    const tags = Array.from({ length: RUN_FIELD_LIMITS.tags + 1 }, (_, index) => `t${index}`);
    const { outcome, row } = await refusedStart({ tags });
    expect(InvalidInput.is(outcome)).toBe(true);
    expect(row).toBeUndefined();
  });

  it('a 129-character tag is refused and no run starts', async () => {
    const { outcome, row } = await refusedStart({ tags: ['x'.repeat(RUN_FIELD_LIMITS.tag + 1)] });
    expect(InvalidInput.is(outcome)).toBe(true);
    expect(row).toBeUndefined();
  });

  it('an empty tag and an empty or too long scope are refused, so every tag and scope is a usable key', async () => {
    expect(InvalidInput.is(await refusedOutcome({ tags: [''] }))).toBe(true);
    expect(InvalidInput.is(await refusedOutcome({ scope: '' }))).toBe(true);
    expect(InvalidInput.is(await refusedOutcome({ scope: 's'.repeat(RUN_FIELD_LIMITS.scope + 1) }))).toBe(true);
  });

  it('metadata over 256 KiB is refused and no run starts, so one run cannot bloat its row and its events', async () => {
    const { outcome, row } = await refusedStart({ metadata: { blob: 'x'.repeat(RUN_FIELD_LIMITS.metadataBytes) } });
    expect(CommandInvalid.is(outcome)).toBe(true);
    if (CommandInvalid.is(outcome)) expect(outcome.data.detail).toContain('the metadata limit');
    expect(row).toBeUndefined();
  });

  it('metadata that is not an object is refused, so code can always read keys from it', async () => {
    for (const metadata of [[1, 2], 'text', 7, null]) {
      const { outcome, row } = await refusedStart({ metadata });
      expect(InvalidInput.is(outcome)).toBe(true);
      expect(row).toBeUndefined();
    }
  });
});
