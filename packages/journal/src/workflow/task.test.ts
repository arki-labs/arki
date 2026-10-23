/**
 * `j.task` on PGlite. A task is the common case: one unit of durable work. It is sugar for a one-step workflow, so it
 * must run, retry, read and nest exactly like the workflow it desugars to; a task that lost its step options or its
 * output schema on the way would look fine and then not retry, or read untyped data.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { TASK_STEP } from './define.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

/** A task with an output schema: `read` checks the stored output with it. */
const double = j.task(
  'test.double',
  { version: 1, input: z.object({ n: z.int() }), output: z.object({ doubled: z.int() }) },
  ({ input }) => ({ doubled: input.n * 2 }),
);

/** Fails its first attempt, so only the task's own `retry` gets it to complete. */
const attemptsSeen: number[] = [];
const flaky = j.task(
  'test.flaky',
  { version: 1, input: z.object({}), retry: backoff.constant(0).upTo(2) },
  ({ attempt }) => {
    attemptsSeen.push(attempt);
    if (attempt === 1) throw new Error('the first attempt fails');
    return attempt;
  },
);

/** A workflow that runs a task as its child and uses the child's output. */
const publish = j
  .workflow('test.publish', { version: 1, input: z.object({ n: z.int() }) })
  .child('double', double, { input: ({ input }) => input })
  .step('post', ({ results }) => `posted ${results.double.doubled}`)
  .finish();

const journal = j.compose({ workflows: [double, flaky, publish], workflowMeta });

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

describe('j.task', () => {
  it('is a workflow of one step named run, with the output schema on the workflow, not on the step', () => {
    expect(double.shape.nodes).toEqual([{ name: TASK_STEP, kind: 'step', undo: false }]);
    expect(double.output).toBeDefined();
    const [node] = double.nodes;
    expect(node?.kind === 'step' ? node.options.output : 'not a step').toBeUndefined();
  });

  it('starts, runs and completes, and def.read gives the typed output', async () => {
    const id = newId('double');
    expect(await journal.run(db, double.start, { input: { n: 21 }, id }, caller)).toEqual({ runId: id });
    await settle();
    const read = await double.read(db, id);
    if (read === undefined || isFailure(read)) throw new Error('the task run is not readable');
    // Why: the output is what the body returned, checked by the task's output schema, as for any workflow.
    expect(read.run).toMatchObject({ state: 'completed', output: { doubled: 42 }, results: { run: { doubled: 42 } } });
  });

  it('passes its step options to the step: `retry` lets the second attempt complete the run', async () => {
    const id = newId('flaky');
    orThrow(await journal.run(db, flaky.start, { input: {}, id }, caller));
    await settle();
    // Why: without the task's retry the step would take the default policy, and this test pins that it is the task's.
    expect(attemptsSeen).toEqual([1, 2]);
    expect(await rowOf(id)).toMatchObject({ state: 'completed', output: 2 });
  });

  it('runs as the child of a workflow, and the parent sees its output', async () => {
    const id = newId('publish');
    orThrow(await journal.run(db, publish.start, { input: { n: 5 }, id }, caller));
    await settle();
    expect(await rowOf(id)).toMatchObject({
      state: 'completed',
      output: 'posted 10',
      results: { double: { doubled: 10 } },
    });
    const children = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.parentId, id));
    expect(children.map(child => ({ name: child.name, state: child.state, rootId: child.rootId }))).toEqual([
      { name: 'test.double', state: 'completed', rootId: id },
    ]);
  });
});
