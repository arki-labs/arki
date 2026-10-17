import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { SchemaInput, SchemaOutput } from '@arki/schema';

import type { CommandConflict } from '../errors.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
const refund = j
  .workflow('refund', { version: 1, input: z.object({ paymentId: z.string(), amount: z.number() }) })
  .step('hold', ({ input, run, db }) => {
    expectTypeOf(input).toEqualTypeOf<{ paymentId: string; amount: number }>();
    // The journal binds its own runner and database into the step context.
    expectTypeOf(run).toBeFunction();
    expectTypeOf(db.select).toBeFunction();
    return { holdId: 'h1' };
  })
  .finish();

describe('def.start, as types', () => {
  it('takes the workflow input and an optional id, and returns the run id or a refusal', () => {
    expectTypeOf<SchemaInput<typeof refund.start.input>>().toEqualTypeOf<{
      readonly input: { paymentId: string; amount: number };
      readonly id?: string;
    }>();
    expectTypeOf<SchemaOutput<typeof refund.start.input>>().toEqualTypeOf<{
      readonly input: { paymentId: string; amount: number };
      readonly id?: string;
    }>();
    expectTypeOf<Awaited<ReturnType<typeof refund.start.handler>>>().toEqualTypeOf<
      { readonly runId: string } | CommandConflict
    >();
  });

  it('a workflow keeps its output type next to start', () => {
    expectTypeOf(refund.name).toBeString();
    expectTypeOf(refund.types).toEqualTypeOf<{ readonly output: { holdId: string } } | undefined>();
  });
});
