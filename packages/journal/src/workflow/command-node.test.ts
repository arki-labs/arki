/**
 * The command node: one command, run as a savepoint inside the checkpoint's transaction. The guarantee it exists for
 * is exactly once per node, even when the job runs again after a crash. A step that calls `ctx.run` cannot give that:
 * the command commits on its own, and a crash before the checkpoint runs it again. These tests hold both next to
 * each other. Real PGlite; the race between two connections is in `command-node.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { WorkflowReadMismatch } from '../errors.js';
import { j, openDb, order, orderId, OrderNoted, OrderPlaced, tables } from '../test-support.js';
import { workflow } from './define.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const op = { actor: 'usr_op', reason: 'test' };
const orderInput = z.object({ orderId: z.templateLiteral(['ord_', z.string()]) });
const noRetry = backoff.constant(0).upTo(0);

const Declined = defineFailure('test.declined', {
  status: 402,
  data: z.object({ reason: z.string() }),
  message: 'declined: {reason}',
});

const noteInput = z.object({
  orderId: z.templateLiteral(['ord_', z.string()]),
  note: z.string().min(1),
  /** The command writes its note, then refuses or dies: both must take the note back. */
  ends: z.enum(['commits', 'declines', 'throws-once']).optional(),
});
let throwsLeft = 0;
/** Writes one note, so the events show how many times the command really committed. */
const note = j.command(
  'test.note',
  noteInput,
  { writes: [OrderNoted], output: z.object({ note: z.string() }) },
  async (input, { write }) => {
    const written = await write(order, input.orderId, () => [OrderNoted({ note: input.note })]);
    if (isFailure(written)) return written;
    if (input.ends === 'declines') return Declined({ reason: input.note });
    if (input.ends === 'throws-once' && throwsLeft > 0) {
      throwsLeft -= 1;
      throw new Error('the database hiccuped');
    }
    return { note: input.note };
  },
);
/** The same write with no `output`: a node keeps `null`, and needs no plain result. */
const bareNote = j.command('test.bareNote', noteInput, { writes: [OrderNoted] }, (input, { write }) =>
  write(order, input.orderId, () => [OrderNoted({ note: input.note })]),
);
/** A command that runs another one: the whole nest is one savepoint of the node. */
const nestedNote = j.command(
  'test.nestedNote',
  noteInput,
  { writes: [], output: z.object({ note: z.string() }) },
  (input, { run }) => run(note, input),
);
/** A result the schema does not accept, after the command already wrote. */
const badResult = j.command(
  'test.badResult',
  noteInput,
  { writes: [OrderNoted], output: z.object({ note: z.string().min(5) }) },
  async (input, { write }) => {
    const written = await write(order, input.orderId, () => [OrderNoted({ note: input.note })]);
    return isFailure(written) ? written : { note: 'no' };
  },
);

const stops = { signal: 'stop', schema: z.object({}) } as const;

const exactlyOnce = j
  .workflow('test.exactly-once', { version: 1, input: orderInput })
  .command('first', note, ({ input }) => ({ orderId: input.orderId, note: 'node first' }))
  .command('second', note, ({ input, results }) => ({ orderId: input.orderId, note: `after ${results.first.note}` }))
  .finish(({ results }) => results.second.note);

const stepTwin = j
  .workflow('test.step-twin', { version: 1, input: orderInput })
  .step('first', ({ input, run }) => run(note, { orderId: input.orderId, note: 'step first' }))
  .finish();

const nesting = j
  .workflow('test.nesting', { version: 1, input: orderInput })
  .command('wrapped', nestedNote, ({ input }) => ({ orderId: input.orderId, note: 'nested' }))
  .finish(({ results }) => results.wrapped.note);

const accepting = j
  .workflow('test.accepting', { version: 1, input: orderInput })
  .command('pay', note, ({ input }) => ({ orderId: input.orderId, note: 'card', ends: 'declines' as const }), {
    accept: [Declined],
  })
  .step('react', ({ results }) => (Declined.is(results.pay) ? `declined: ${results.pay.data.reason}` : 'paid'))
  .finish();

const refused = (onDeadStep: 'wait' | 'compensate') =>
  j
    .workflow(`test.refused-${onDeadStep}`, { version: 1, input: orderInput, onDeadStep })
    .command('pay', note, ({ input }) => ({ orderId: input.orderId, note: 'card', ends: 'declines' as const }), {
      retry: noRetry,
    })
    .step('after', () => 'never')
    .finish();
const refusedWait = refused('wait');
const refusedCompensate = refused('compensate');

const compensating = j
  .workflow('test.compensating', { version: 1, input: orderInput })
  .command('one', note, ({ input }) => ({ orderId: input.orderId, note: 'do one' }), {
    undo: { command: note, input: ({ input, result }) => ({ orderId: input.orderId, note: `undo ${result.note}` }) },
  })
  .command('declined', note, ({ input }) => ({ orderId: input.orderId, note: 'refused', ends: 'declines' as const }), {
    accept: [Declined],
    undo: { command: note, input: ({ input }) => ({ orderId: input.orderId, note: 'undo of a refused node' }) },
  })
  .command(
    'two',
    note,
    ({ input, results }) => ({ orderId: input.orderId, note: `do two after ${results.one.note}` }),
    {
      undo: {
        command: note,
        input: ({ input, results, result }) => ({
          orderId: input.orderId,
          note: `undo ${result.note} after ${results.one.note}`,
        }),
      },
    },
  )
  .waitFor('stop', stops)
  .finish(() => 'done');

const skipping = j
  .workflow('test.skipping', { version: 1, input: orderInput.extend({ skip: z.boolean() }) })
  .command('maybe', note, ({ input }) => ({ orderId: input.orderId, note: 'maybe' }), {
    when: ({ input }) => !input.skip,
  })
  .command('bare', bareNote, ({ input }) => ({ orderId: input.orderId, note: 'bare' }))
  .finish(({ results }) => ({ maybe: results.maybe, bare: results.bare }));

const retrying = j
  .workflow('test.retrying', { version: 1, input: orderInput })
  .command('flaky', note, ({ input }) => ({ orderId: input.orderId, note: 'flaky', ends: 'throws-once' as const }), {
    retry: backoff.constant(0).upTo(3),
  })
  .finish(({ results }) => results.flaky.note);

const retryingRefusal = j
  .workflow('test.retrying-refusal', { version: 1, input: orderInput })
  .command('pay', note, ({ input }) => ({ orderId: input.orderId, note: 'card', ends: 'declines' as const }), {
    retry: backoff
      .constant(0)
      .upTo(2)
      .while(reason => Declined.is(reason)),
  })
  .finish(() => 'never');

const unchecked = j
  .workflow('test.unchecked', { version: 1, input: orderInput, onDeadStep: 'wait' })
  .command('bad', badResult, ({ input }) => ({ orderId: input.orderId, note: 'written' }), { retry: noRetry })
  .finish(() => 'never');

const resolvable = j
  .workflow('test.resolvable', { version: 1, input: orderInput, onDeadStep: 'wait' })
  .command('pay', note, ({ input }) => ({ orderId: input.orderId, note: 'card', ends: 'declines' as const }), {
    retry: noRetry,
  })
  .step('after', ({ results }) => `resolved ${results.pay.note}`)
  .finish();

const held = j
  .workflow('test.held', { version: 1, input: orderInput })
  .command('done', note, ({ input }) => ({ orderId: input.orderId, note: 'held do' }), {
    undo: { command: note, input: ({ input }) => ({ orderId: input.orderId, note: 'held undo' }) },
  })
  .command('late', note, ({ input }) => ({ orderId: input.orderId, note: 'held late' }))
  .finish();

/** What a plain effect's context holds: D-11 says it reaches out, so the test reads the real object a worker builds. */
let effectKeys: string[] = [];
const contextProbe = j.effect('test.context-probe', order, {
  OrderPlaced: (_event, context) => {
    effectKeys = Object.keys(context);
  },
});

const journal = j.compose({
  effects: [contextProbe],
  workflows: [
    exactlyOnce,
    stepTwin,
    nesting,
    accepting,
    refusedWait,
    refusedCompensate,
    compensating,
    skipping,
    retrying,
    retryingRefusal,
    unchecked,
    resolvable,
    held,
  ],
  workflowMeta,
});

/** Throws the first time the checkpoint of a run's command would commit: the process died right there. */
let crashes = 0;
journal.hooks.command.around(async (ctx, next) => {
  if (ctx.name === 'workflow.checkpoint' && crashes > 0) {
    crashes -= 1;
    throw new Error('the process died between the command and the checkpoint');
  }
  return next();
});
/** Throws after a step's body or a node's command returned: the same point of a crash for both. */
let diesAfterBody = 0;
/** Runs after the job read the node and before the attempt takes the run's lock. */
let afterLook: (() => Promise<void>) | undefined;
journal.hooks.step.around(async (_ctx, next) => {
  await afterLook?.();
  afterLook = undefined;
  await next();
  if (diesAfterBody > 0) {
    diesAfterBody -= 1;
    throw new Error('the process died after the body');
  }
});
/** Runs before a step job's body, on a claimed job: a test uses it to act while the job is in flight. */
let beforeStepJob: (() => Promise<void>) | undefined;
/** Throws after a step job finished: the transaction committed, and the ack was lost. */
let ackLost = 0;
journal.hooks.effect.around(async (ctx, next) => {
  const before = ctx.name === 'workflow.step' ? beforeStepJob : undefined;
  beforeStepJob = before === undefined ? beforeStepJob : undefined;
  await before?.();
  await next();
  if (ctx.name === 'workflow.step' && ackLost > 0) {
    ackLost -= 1;
    throw new Error('the process died before the ack');
  }
});

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

async function placed() {
  const id = orderId(++next);
  orThrow(
    await db.transaction(tx =>
      journal.write(tx, order, id, { meta: caller, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
    ),
  );
  return id;
}

/** Runs every due job. A delayed retry is made due, as a clock moved forward would. */
async function settle(limit = 30) {
  for (let pass = 0; pass < limit; pass++) {
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(sql`dead_at IS NULL`);
    if ((await journal.drain(db, { leaseSeconds: 60 }).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the jobs did not settle');
}

const notesOf = async (id: string) => {
  const rows = await db
    .select({ data: tables.events.data })
    .from(tables.events)
    .where(and(eq(tables.events.entityId, id), eq(tables.events.type, 'OrderNoted')))
    .orderBy(asc(tables.events.seq));
  return rows.map(row => z.object({ note: z.string() }).parse(row.data).note);
};
const runOf = async (runId: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
  return row;
};
const stepOf = async (runId: string, path: string, phase: 'do' | 'undo' = 'do') => {
  const [row] = await db
    .select()
    .from(tables.workflowSteps)
    .where(
      and(
        eq(tables.workflowSteps.runId, runId),
        eq(tables.workflowSteps.path, path),
        eq(tables.workflowSteps.phase, phase),
      ),
    );
  return row;
};

describe('a command node, on the happy path', () => {
  it('commits the command, the checkpoint and the next node together, and later nodes read the typed result', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, exactlyOnce.start, { id: `once:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual(['node first', 'after node first']);
    expect(await runOf(runId)).toMatchObject({
      state: 'completed',
      output: 'after node first',
      results: { first: { note: 'node first' }, second: { note: 'after node first' } },
    });
    // The command's events record the app's workflowMeta: the run is the actor, by the app's own choice.
    const [noted] = await db
      .select({ meta: tables.events.meta })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, id), eq(tables.events.type, 'OrderNoted')));
    expect(noted?.meta).toEqual(workflowMeta);
  });

  it('a skipped node runs no command and its result is null; a command with no output keeps null', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, skipping.start, { id: `skip:${id}`, input: { orderId: id, skip: true } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual(['bare']);
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: { maybe: null, bare: null } });
    expect(await stepOf(runId, 'maybe')).toMatchObject({ status: 'skipped' });
  });
});

describe('the guarantee: exactly once per node', () => {
  it('a crash between the command and the checkpoint rolls the command back, so the retried job runs it once', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, exactlyOnce.start, { id: `crash:${id}`, input: { orderId: id } }, caller),
    );
    crashes = 1;
    await settle();
    expect(crashes).toBe(0);
    expect(await notesOf(id)).toEqual(['node first', 'after node first']);
    expect(await runOf(runId)).toMatchObject({ state: 'completed' });
  });

  it("a command run from inside the node's command rolls back with it, so the nest runs once as well", async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, nesting.start, { id: `nest:${id}`, input: { orderId: id } }, caller),
    );
    crashes = 1;
    await settle();
    expect(crashes).toBe(0);
    expect(await notesOf(id)).toEqual(['nested']);
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'nested' });
  });

  it('the same crash point: a step that calls ctx.run commits the command twice, a command node once', async () => {
    const stepped = await placed();
    orThrow(await journal.run(db, stepTwin.start, { id: `twin:${stepped}`, input: { orderId: stepped } }, caller));
    diesAfterBody = 1;
    await settle();
    expect(diesAfterBody).toBe(0);
    expect(await notesOf(stepped), 'a step is at-least-once: this is what the node removes').toEqual([
      'step first',
      'step first',
    ]);

    const noded = await placed();
    orThrow(await journal.run(db, exactlyOnce.start, { id: `noded:${noded}`, input: { orderId: noded } }, caller));
    diesAfterBody = 1;
    await settle();
    expect(diesAfterBody).toBe(0);
    expect(await notesOf(noded)).toEqual(['node first', 'after node first']);
  });

  it('a job that runs again after the commit, because the ack was lost, finds the node settled and runs nothing', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, exactlyOnce.start, { id: `ack:${id}`, input: { orderId: id } }, caller),
    );
    ackLost = 2;
    await settle();
    expect(ackLost).toBe(0);
    expect(await notesOf(id)).toEqual(['node first', 'after node first']);
    expect(await runOf(runId)).toMatchObject({ state: 'completed' });
  });

  it("a node that settled after the job read it runs nothing: the attempt looks again under the run's lock", async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, exactlyOnce.start, { id: `late:${id}`, input: { orderId: id } }, caller),
    );
    // What a commit by another attempt leaves behind, landing in the gap between the look and the lock.
    afterLook = async () => {
      await db
        .update(tables.workflowSteps)
        .set({ status: 'done', result: { note: 'the other attempt' } })
        .where(and(eq(tables.workflowSteps.runId, runId), eq(tables.workflowSteps.path, 'first')));
    };
    await settle();
    expect(await notesOf(id)).toEqual([]);
  });

  it('a command that throws leaves nothing and is tried again by the retry policy, like a step that throws', async () => {
    const id = await placed();
    throwsLeft = 1;
    const { runId } = orThrow(
      await journal.run(db, retrying.start, { id: `flaky:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual(['flaky']);
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'flaky' });
    expect(await stepOf(runId, 'flaky')).toMatchObject({ status: 'done', attempt: 2 });
  });

  it('a result its schema refuses takes the command back too, so a failed attempt wrote nothing', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, unchecked.start, { id: `bad:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual([]);
    expect(await stepOf(runId, 'bad')).toMatchObject({ status: 'failed' });
  });
});

describe('a refused command', () => {
  it('with accept: the savepoint stays rolled back, the run goes on, and the failure is a real one for later nodes', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, accepting.start, { id: `acc:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id), 'the refused command wrote nothing').toEqual([]);
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'declined: card' });

    const read = orThrow(await accepting.read(db, runId));
    const pay = read?.run.results.pay;
    expect(Declined.is(pay)).toBe(true);
    if (Declined.is(pay)) expect(pay.data).toEqual({ reason: 'card' });
  });

  it('with accept: a stored failure that no definition names is a read mismatch, never handed out as is', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, accepting.start, { id: `mis:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    await db
      .update(tables.workflowRuns)
      .set({ results: { pay: { '~refused': { version: 1, code: 'test.gone' } }, react: 'x' } })
      .where(eq(tables.workflowRuns.id, runId));
    expect(WorkflowReadMismatch.is(await accepting.read(db, runId))).toBe(true);
  });

  it('without accept: the savepoint rolls back, the failure commits, and onDeadStep wait leaves it for an operator', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, refusedWait.start, { id: `wait:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual([]);
    expect(await stepOf(runId, 'pay')).toMatchObject({ status: 'failed' });
    expect(await runOf(runId)).toMatchObject({ state: 'running', finishedAt: null });
    const [job] = await db.select().from(tables.jobs).where(eq(tables.jobs.runId, runId));
    expect(job, 'a dead step keeps a dead job, so an operator finds it').toMatchObject({ deadAt: expect.any(Date) });
  });

  it('without accept: under onDeadStep compensate the run fails, and the node that was refused is not undone', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, refusedCompensate.start, { id: `comp:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'failed', finishedAt: expect.any(Date) });
    expect(await stepOf(runId, 'after')).toBeUndefined();
  });

  it('a retry whose while accepts the failure tries again, and each attempt wrote nothing', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, retryingRefusal.start, { id: `again:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await notesOf(id)).toEqual([]);
    expect(await stepOf(runId, 'pay')).toMatchObject({ status: 'failed', attempt: 3 });
  });

  it('an operator can retry a dead node, or give its result: the output schema checks that result', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, resolvable.start, { id: `op:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    orThrow(await journal.workflows.retryStep(db, { runId, path: 'pay', phase: 'do' }, op));
    await settle();
    expect(await stepOf(runId, 'pay')).toMatchObject({ status: 'failed', attempt: 2 });

    const refused = await journal.workflows.checkResult(db, { runId, path: 'pay', result: { note: 1 } });
    expect(refused).toMatchObject({ ok: false });
    expect(await journal.workflows.checkResult(db, { runId, path: 'pay', result: { note: 'hand' } })).toEqual({
      ok: true,
    });
    orThrow(await journal.workflows.resolveStep(db, { runId, path: 'pay', result: { note: 'hand' } }, op));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'resolved hand' });
    expect(await notesOf(id), 'the operator gave the result: the command never ran').toEqual([]);
  });
});

describe('undo', () => {
  it('runs in reverse order on compensation, once each, sees the stored result, and skips a refused node', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, compensating.start, { id: `undo:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'parked' });
    expect(await notesOf(id)).toEqual(['do one', 'do two after do one']);

    orThrow(await journal.run(db, compensating.cancel, { runId, reason: 'stop' }, caller));
    await settle();

    expect(await notesOf(id)).toEqual([
      'do one',
      'do two after do one',
      'undo do two after do one after do one',
      'undo do one',
    ]);
    expect(await runOf(runId)).toMatchObject({ state: 'cancelled' });
    expect(await stepOf(runId, 'declined', 'undo')).toMatchObject({ status: 'skipped' });
  });

  it('a crash in an undo rolls it back with its checkpoint, so it runs once', async () => {
    const id = await placed();
    const { runId } = orThrow(
      await journal.run(db, compensating.start, { id: `ucrash:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    orThrow(await journal.run(db, compensating.cancel, { runId, reason: 'stop' }, caller));
    crashes = 1;
    await settle();
    expect(crashes).toBe(0);
    const notes = await notesOf(id);
    expect(notes.filter(text => text.startsWith('undo'))).toEqual([
      'undo do two after do one after do one',
      'undo do one',
    ]);
    expect(await runOf(runId)).toMatchObject({ state: 'cancelled' });
  });

  it('a run that began compensating while the job waited drops the node: its command never runs', async () => {
    const id = await placed();
    await settle();
    const { runId } = orThrow(await journal.run(db, held.start, { id: `held:${id}`, input: { orderId: id } }, caller));
    // The first node runs; the second job is claimed, and the cancel lands before its command starts.
    expect(await journal.drain(db, { batchSize: 1 }).then(result => orThrow(result))).toBe(1);
    beforeStepJob = async () => {
      expect(await journal.run(db, held.cancel, { runId, reason: 'stop' }, caller)).toEqual({ state: 'compensating' });
    };
    await settle();
    expect(await notesOf(id)).toEqual(['held do', 'held undo']);
    expect(await stepOf(runId, 'late')).toMatchObject({ status: 'skipped' });
    expect(await runOf(runId)).toMatchObject({ state: 'cancelled' });
  });
});

describe('an effect', () => {
  it("gets a context that cannot run a command, while the engine's own effects still can", async () => {
    const id = await placed();
    await settle();
    expect(effectKeys).toEqual(expect.arrayContaining(['jobId', 'attempt', 'signal', 'db']));
    expect(effectKeys).not.toContain('run');
    expect(effectKeys).not.toContain('accept');
    // The engine runs on the same worker: a run still moves, so only the app's effects lost `run`.
    const { runId } = orThrow(
      await journal.run(db, exactlyOnce.start, { id: `probe:${id}`, input: { orderId: id } }, caller),
    );
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'completed' });
  });
});

describe('the shape of a command node', () => {
  const input = z.object({});
  const nodes = (undone: boolean) =>
    workflow('refund', { version: 1, input })
      .command(
        'pay',
        note,
        () => ({ orderId: orderId(1), note: 'x' }),
        undone ? { undo: { command: bareNote, input: () => ({ orderId: orderId(1), note: 'y' }) } } : {},
      )
      .finish(() => 1);

  it('stores the kind and the names of its commands, so the event map can draw it', () => {
    expect(nodes(true).shape.nodes).toEqual([
      { name: 'pay', kind: 'command', undo: true, command: 'test.note', undoCommand: 'test.bareNote' },
    ]);
    expect(nodes(false).shape.nodes).toEqual([{ name: 'pay', kind: 'command', undo: false, command: 'test.note' }]);
  });

  it('a change of command is a change of shape', () => {
    const named = (command: typeof note | typeof badResult) =>
      workflow('refund', { version: 1, input })
        .command('pay', command, () => ({ orderId: orderId(1), note: 'x' }))
        .finish(() => 1).shapeHash;
    expect(named(note)).not.toBe(named(badResult));
    expect(nodes(true).shapeHash).not.toBe(nodes(false).shapeHash);
  });

  it('existing kinds keep their hash, so a running workflow is not stranded by this release', () => {
    const child = workflow('child', { version: 1, input })
      .step('a', () => 1)
      .finish();
    const def = workflow('pinned', { version: 1, input })
      .step('s', () => 1, { undo: () => 1 })
      .waitFor('w', { signal: 'sig', schema: z.object({}) })
      .sleep('z', '1h')
      .child('c', child, { input: () => ({}) })
      .map('m', child, { items: () => [1], input: () => ({}) })
      .finish();
    // Worked out with the hash code at the commit before command nodes. If this moves, every running workflow strands.
    expect(def.shapeHash).toBe('451d2632233c1e97');
  });

  it('a last node that can end in an accepted failure needs a finish function: a run has no failure as its output', () => {
    expect(() =>
      workflow('ends-refused', { version: 1, input })
        .command('pay', note, () => ({ orderId: orderId(1), note: 'x' }), { accept: [Declined] })
        // @ts-expect-error -- the same rule is a type error; this proves the definition-time backstop.
        .finish(),
    ).toThrow(/finish needs a function/);
    expect(() =>
      workflow('ends-refused', { version: 1, input })
        .command('pay', note, () => ({ orderId: orderId(1), note: 'x' }), { accept: [Declined] })
        .finish(({ results }) => (Declined.is(results.pay) ? 'refused' : 'paid')),
    ).not.toThrow();
  });
});
