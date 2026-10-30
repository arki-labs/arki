/**
 * A step that lists `failures` and sets `onFailure: 'continue'` keeps a returned failure as its result and the run goes
 * on. The failure is stored as its envelope and read back, by the failure's own schema, as a real failure. A failure the
 * step does not list still fails the step. Real PGlite.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { j, openDb, tables } from '../test-support.js';
import { workflow } from './define.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const input = z.object({ amount: z.number() });
const noRetry = backoff.constant(0).upTo(0);

const Declined = defineFailure('test.step-declined', {
  status: 402,
  data: z.object({ reason: z.string() }),
  message: 'declined: {reason}',
});
const Fraud = defineFailure('test.step-fraud', { status: 403, message: 'fraud' });

const charge = (amount: number) => (amount > 100 ? Fraud() : amount > 10 ? Declined({ reason: 'too big' }) : { paid: amount });

const continuing = j
  .workflow('test.step-continue', { version: 1, input })
  .step('pay', ({ input: given }) => charge(given.amount), {
    output: z.object({ paid: z.number() }),
    failures: [Declined],
    onFailure: 'continue',
    retry: noRetry,
  })
  .step('react', ({ results }) => (Declined.is(results.pay) ? `declined: ${results.pay.data.reason}` : 'paid'))
  .finish(({ results }) => results.react);

const endsInFailure = j
  .workflow('test.step-continue-last', { version: 1, input })
  .step('pay', ({ input: given }) => charge(given.amount), {
    output: z.object({ paid: z.number() }),
    failures: [Declined],
    onFailure: 'continue',
    retry: noRetry,
  })
  .finish(({ results }) => (Declined.is(results.pay) ? 'declined' : 'paid'));

/** A success that looks like a stored refusal: read as one, it would skip its undo and fail `read`. */
const lookalike = j
  .workflow('test.step-refused-lookalike', { version: 1, input })
  .step('spoof', () => ({ '~refused': { code: Declined.code } }), { retry: noRetry })
  .finish();

const journal = j.compose({ workflows: [continuing, endsInFailure, lookalike], workflowMeta });
let db: PgliteDatabase;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

async function settle() {
  for (let pass = 0; pass < 30; pass++) {
    await db.update(tables.jobs).set({ availableAt: new Date(0) }).where(sql`dead_at IS NULL`);
    if (orThrow(await journal.drain(db, { leaseSeconds: 60 })) === 0) return;
  }
  throw new Error('the jobs did not settle');
}
const runOf = async (runId: string) => {
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
  return row;
};

describe('a step that continues on a listed failure', () => {
  it('stores the failure as the result, runs the next node on it, and reads it back as a real failure', async () => {
    const { runId } = orThrow(await journal.run(db, continuing.start, { id: 'cont:declined', input: { amount: 50 } }, caller));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'declined: too big' });
    const read = orThrow(await continuing.read(db, runId));
    const paid = read?.run.results.pay;
    expect(Declined.is(paid)).toBe(true);
    if (!Declined.is(paid)) throw new Error('the failure was not read back');
    expect(paid.data.reason).toBe('too big');
  });

  it('a success shaped like a stored refusal is refused, never stored to be read as a failure', async () => {
    const { runId } = orThrow(await journal.run(db, lookalike.start, { id: 'cont:lookalike', input: { amount: 1 } }, caller));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'running', results: {} });
    const [step] = await db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, runId));
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain('refused result');
  });

  it('a success passes through the output schema as it always did', async () => {
    const { runId } = orThrow(await journal.run(db, continuing.start, { id: 'cont:paid', input: { amount: 5 } }, caller));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'paid', results: { pay: { paid: 5 } } });
  });

  it('a failure the step does not list still fails the step', async () => {
    const { runId } = orThrow(await journal.run(db, continuing.start, { id: 'cont:fraud', input: { amount: 500 } }, caller));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'running' });
    const [step] = await db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, runId));
    expect(step?.status).toBe('failed');
    // The failure itself is the cause, not a complaint that it could not be stored.
    expect(step?.error).toContain('test.step-fraud');
  });

  it('the last node can be a continued failure when finish turns it into an output', async () => {
    const { runId } = orThrow(await journal.run(db, endsInFailure.start, { id: 'cont:last', input: { amount: 50 } }, caller));
    await settle();
    expect(await runOf(runId)).toMatchObject({ state: 'completed', output: 'declined' });
  });
});

describe('the rules of the options, at definition time and in the types', () => {
  it('onFailure without a failures list, failures without onFailure, and a missing output schema are refused', () => {
    expect(() =>
      // Not a type error: the list is checked when the definition is built.
      workflow('bad-1', { version: 1, input }).step('s', () => 1, { onFailure: 'continue', output: z.number() }),
    ).toThrow(/lists no failures/);
    expect(() =>
      workflow('bad-2', { version: 1, input }).step('s', () => (1 as number | ReturnType<typeof Declined>), {
        output: z.number(),
        failures: [Declined],
      }),
    ).toThrow(/no onFailure/);
    expect(() =>
      workflow('bad-3', { version: 1, input }).step('s', () => (1 as number | ReturnType<typeof Declined>), {
        failures: [Declined],
        // @ts-expect-error -- continuing needs an output schema.
        onFailure: 'continue',
      }),
    ).toThrow(/needs an output schema/);
  });

  it('finish without a function is a type error when the last result can be a failure, and the definition backstops it', () => {
    expect(() =>
      workflow('ends-failed', { version: 1, input })
        .step('s', () => (1 as number | ReturnType<typeof Declined>), {
          output: z.number(),
          failures: [Declined],
          onFailure: 'continue',
        })
        // @ts-expect-error -- a run's output is never a failure.
        .finish(),
    ).toThrow(/finish needs a function/);
  });
});
