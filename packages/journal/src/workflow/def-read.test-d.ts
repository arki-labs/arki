import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { ValidatorDefect } from '@arki/failure';

import type { DbHandle } from '../types.js';
import { WorkflowReadMismatch } from '../errors.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const kid = j
  .workflow('kid', { version: 1, input: z.object({}) })
  .step('k', () => 1)
  .finish();
/**
 * `hold`, `charge` (which returns a promise) and `bonus` declare an `output` schema; `notify` does not; `approve` is a
 * wait that may time out.
 */
const payment = j
  .workflow('payment', { version: 1, input: z.object({ amount: z.number() }), output: z.object({ total: z.number() }) })
  .step('hold', () => ({ holdId: 'h' }), { output: z.object({ holdId: z.string() }) })
  .step('charge', () => Promise.resolve({ chargeId: 'c' }), { output: z.object({ chargeId: z.string() }) })
  .step('notify', () => ({ sent: true }))
  .step('bonus', () => ({ points: 1 }), {
    output: z.object({ points: z.number() }),
    when: ({ input }) => input.amount > 10,
  })
  .waitFor('approve', { signal: 'approve', schema: z.object({ by: z.string() }), onTimeout: 'continue' })
  .waitFor('review', { signal: 'review', schema: z.object({ ok: z.boolean() }), when: ({ input }) => input.amount > 99 })
  .waitFor('receipt', { signal: 'receipt', schema: z.object({ no: z.string() }) })
  .child('ledger', kid, { input: () => ({}) })
  .map('fan', kid, { items: () => [1], input: () => ({}) })
  // A finish that reads its ctx, with a declared output: this used to need a second argument.
  .finish(({ input }) => ({ total: input.amount }));
declare const db: DbHandle;

describe('def.read, as types', () => {
  it('types what a schema checked, and leaves the rest unknown', async () => {
    const read = await payment.read(db, 'r');
    if (read === undefined || 'code' in read) return;
    const { input, output, results } = read.run;
    expectTypeOf(input).toEqualTypeOf<{ amount: number }>();
    expectTypeOf(output).toEqualTypeOf<{ total: number } | null>();
    expectTypeOf(results.hold).toEqualTypeOf<{ holdId: string } | undefined>();
    expectTypeOf(results.charge).toEqualTypeOf<{ chargeId: string } | undefined>();
    expectTypeOf(results.notify).toBeUnknown();
    expectTypeOf(results.bonus).toEqualTypeOf<{ points: number } | null | undefined>();
    expectTypeOf(results.approve).toEqualTypeOf<{ by: string } | null | undefined>();
    // A wait with `when` may be skipped, so its checked result may be `null`; a wait without it never is.
    expectTypeOf(results.review).toEqualTypeOf<{ ok: boolean } | null | undefined>();
    expectTypeOf(results.receipt).toEqualTypeOf<{ no: string } | undefined>();
    expectTypeOf(results.ledger).toBeUnknown();
    expectTypeOf(results.fan).toBeUnknown();
    // @ts-expect-error the input schema has no `currency`
    expectTypeOf(input.currency).toBeUnknown();
    // @ts-expect-error the output schema has no `currency`
    expectTypeOf(output?.currency).toBeUnknown();
    // @ts-expect-error no node is called `refund`
    expectTypeOf(results.refund).toBeUnknown();
  });

  it('can be a refusal or nothing, which the caller must handle before the run', async () => {
    const read = await payment.read(db, 'r');
    expectTypeOf<Extract<typeof read, WorkflowReadMismatch>>().toEqualTypeOf<WorkflowReadMismatch>();
    expectTypeOf<Extract<typeof read, ReturnType<typeof ValidatorDefect>>>().not.toBeNever();
    expectTypeOf<Extract<typeof read, undefined>>().toEqualTypeOf<undefined>();
    // @ts-expect-error the read may be a failure or undefined, so `run` is not there yet
    expectTypeOf(read.run).toBeObject();
    if (WorkflowReadMismatch.is(read)) expectTypeOf(read.data.field).toBeString();
  });

  it('a finish with a declared output must return that output', () => {
    const declared = j
      .workflow('declared', { version: 1, input: z.object({}), output: z.object({ total: z.number() }) })
      .step('count', () => 1);
    declared.finish(({ results }) => ({ total: results.count }));
    declared.finish(({ results }) => Promise.resolve({ total: results.count }));
    // @ts-expect-error `total` must be a number
    declared.finish(({ results }) => ({ total: String(results.count) }));
    // @ts-expect-error without a function the output is the last result, a number, not `{ total }`
    declared.finish();
  });
});
