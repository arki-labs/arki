import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { PgliteDatabase } from 'drizzle-orm/pglite';

import type { RootDb } from '../types.js';
import type { CommandNotFound, WorkflowPending, WorkflowRunCancelled, WorkflowRunFailed } from '../errors.js';
import type { RunDetail } from './read.js';
import { j, meta } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const priced = j
  .workflow('priced', { version: 1, input: z.object({ amount: z.number() }), output: z.object({ total: z.number() }) })
  .step('quote', () => ({ price: 1 }), { output: z.object({ price: z.number() }) })
  .finish(({ input }) => ({ total: input.amount }));
const bare = j
  .workflow('bare', { version: 1, input: z.object({}) })
  .step('s', () => 1)
  .finish();
declare const db: RootDb;
/** A real Drizzle transaction has `rollback()`, so it is not the root database. */
declare const tx: Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];

describe('def.settled, as types', () => {
  it('is the typed run, or pending, or not found, and nothing else', async () => {
    const settled = await priced.settled(db, 'r', { within: 5 });
    type Typed = RunDetail<{ amount: number }, { total: number }, { readonly quote?: { price: number } }>;
    expectTypeOf(settled).toExtend<Typed | WorkflowPending | CommandNotFound | { readonly code: string }>();
    if (!('code' in settled)) {
      expectTypeOf(settled.run.output).toEqualTypeOf<{ total: number } | null>();
      expectTypeOf(settled.run.results.quote).toEqualTypeOf<{ price: number } | undefined>();
    }
  });

  it('refuses a missing within, a non-number, and a transaction handle', () => {
    // @ts-expect-error -- within is required.
    void priced.settled(db, 'r', {});
    // @ts-expect-error -- within is a number of seconds.
    void priced.settled(db, 'r', { within: '5s' });
    // @ts-expect-error -- a transaction is not the root database.
    void priced.settled(tx, 'r', { within: 5 });
  });
});

describe('def.startAndWait, as types', () => {
  it('is the output, or one of the named failures', async () => {
    const result = await priced.startAndWait(db, { input: { amount: 2 } }, { meta, timeout: 5 });
    if (result !== null && !('code' in result)) expectTypeOf(result).toEqualTypeOf<{ total: number }>();
    const failed: WorkflowRunFailed | WorkflowRunCancelled | WorkflowPending | null | { total: number } | { readonly code: string } = result;
    expectTypeOf(failed).not.toBeAny();
  });

  it('a workflow with no output schema gives unknown, never a guessed type', async () => {
    const result = await bare.startAndWait(db, { input: {} }, { meta, timeout: 5 });
    expectTypeOf(result).toBeUnknown();
  });

  it('refuses a wrong input, a missing timeout, a wrong meta and a transaction handle', () => {
    // @ts-expect-error -- the input is the workflow's input.
    void priced.startAndWait(db, { input: { amount: 'x' } }, { meta, timeout: 5 });
    // @ts-expect-error -- timeout is required.
    void priced.startAndWait(db, { input: { amount: 2 } }, { meta });
    // @ts-expect-error -- meta is the journal's meta.
    void priced.startAndWait(db, { input: { amount: 2 } }, { meta: { actor: 1 }, timeout: 5 });
    // @ts-expect-error -- a transaction is not the root database.
    void priced.startAndWait(tx, { input: { amount: 2 } }, { meta, timeout: 5 });
  });
});
