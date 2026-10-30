/**
 * `def.read` for the node kinds that wait or fan out: a sleep, a child, and a map that waits for all or for any. A
 * stored result is checked with the child's `output` schema, never handed out as it lies in the row. A child chosen at
 * run time has no schema, so it is read as `unknown`. Real PGlite.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { WorkflowReadMismatch } from '../errors.js';
import { j, openDb, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const kid = j
  .workflow('readnodes.kid', { version: 1, input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) })
  .step('double', ({ input }) => ({ doubled: input.n * 2 }))
  .finish(({ results }) => results.double);
const parent = j
  .workflow('readnodes.parent', { version: 1, input: z.object({}) })
  .sleep('nap', () => new Date())
  .child('one', kid, { input: () => ({ n: 1 }) })
  .child('picked', () => kid, { input: () => ({ n: 2 }) })
  .map('many', kid, { items: () => [3, 4], input: (_ctx, item) => ({ n: item }) })
  .map('first', kid, { items: () => [5], input: (_ctx, item) => ({ n: item }), wait: 'any' })
  .finish(({ results }) => results.many.length);

const journal = j.compose({ workflows: [parent, kid], workflowMeta });
let db: PgliteDatabase;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

async function settle() {
  for (let pass = 0; pass < 40; pass++) {
    await db.update(tables.jobs).set({ availableAt: new Date(0) }).where(sql`dead_at IS NULL`);
    if (orThrow(await journal.drain(db, { leaseSeconds: 60 })) === 0) return;
  }
  throw new Error('the jobs did not settle');
}

describe('def.read of a sleep, a child and a map', () => {
  it('checks and gives each result with its own type', async () => {
    const { runId } = orThrow(await journal.run(db, parent.start, { id: 'rn:ok', input: {} }, caller));
    await settle();
    const read = orThrow(await parent.read(db, runId));
    expect(read?.run.state).toBe('completed');
    expect(read?.run.results).toEqual({
      nap: null,
      one: { doubled: 2 },
      picked: { doubled: 4 },
      many: [{ doubled: 6 }, { doubled: 8 }],
      first: { doubled: 10 },
    });
  });

  it('a stored list item that does not fit the child schema is a read mismatch naming the item', async () => {
    const { runId } = orThrow(await journal.run(db, parent.start, { id: 'rn:bad-item', input: {} }, caller));
    await settle();
    await db
      .update(tables.workflowRuns)
      .set({ results: sql`jsonb_set(${tables.workflowRuns.results}, '{many,1}', '{"doubled":"eight"}')` })
      .where(eq(tables.workflowRuns.id, runId));
    const read = await parent.read(db, runId);
    expect(WorkflowReadMismatch.is(read)).toBe(true);
    if (!WorkflowReadMismatch.is(read)) throw new Error('expected a mismatch');
    expect(read.data.field).toBe('results.many[1]');
  });

  it('a stored map result that is not a list, a child result that does not fit, and a sleep result that is not null are mismatches', async () => {
    const { runId } = orThrow(await journal.run(db, parent.start, { id: 'rn:bad-shapes', input: {} }, caller));
    await settle();
    const fieldAfter = async (key: string, value: string) => {
      await db
        .update(tables.workflowRuns)
        .set({ results: sql`jsonb_set(${tables.workflowRuns.results}, ${key}::text[], ${value}::jsonb)` })
        .where(eq(tables.workflowRuns.id, runId));
      const read = await parent.read(db, runId);
      if (!WorkflowReadMismatch.is(read)) throw new Error(`expected a mismatch after ${key}`);
      return read.data.field;
    };
    expect(await fieldAfter('{many}', '{"not":"a list"}')).toBe('results.many');
    await db.update(tables.workflowRuns).set({ results: sql`jsonb_set(${tables.workflowRuns.results}, '{many}', '[{"doubled":6},{"doubled":8}]')` }).where(eq(tables.workflowRuns.id, runId));
    expect(await fieldAfter('{one}', '{"doubled":"x"}')).toBe('results.one');
    await db.update(tables.workflowRuns).set({ results: sql`jsonb_set(${tables.workflowRuns.results}, '{one}', '{"doubled":2}')` }).where(eq(tables.workflowRuns.id, runId));
    expect(await fieldAfter('{nap}', '"slept"')).toBe('results.nap');
  });
});
