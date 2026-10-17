import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { SchemaInput, SchemaOutput } from '@arki/schema';

import type { CommandConflict } from '../errors.js';
import type { NoSignals } from './define.js';
import type { SignalOutcome } from './runner.js';
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

const approval = j
  .workflow('approval', { version: 1, input: z.object({}) })
  .waitFor('granted', { signal: 'approval.granted', schema: z.object({ by: z.string() }) })
  .waitFor('shipped', { signal: 'order.shipped', schema: z.object({ at: z.coerce.date() }) })
  .finish();

describe('def.signal, as types', () => {
  it('names only the signals the workflow waits for', () => {
    expectTypeOf<keyof NonNullable<typeof approval.types>['signals']>().toEqualTypeOf<
      'approval.granted' | 'order.shipped'
    >();
  });

  it("takes the input of that signal's schema as the payload, so a webhook is checked before it is sent", () => {
    const _granted = approval.signal('approval.granted');
    expectTypeOf<SchemaInput<typeof _granted.input>['payload']>().toEqualTypeOf<{ by: string }>();
    expectTypeOf<SchemaInput<typeof _granted.input>['runId']>().toBeString();
    const _shipped = approval.signal('order.shipped');
    // A schema that coerces takes more than it returns: the sender may pass the input.
    expectTypeOf<SchemaInput<typeof _shipped.input>['payload']>().toEqualTypeOf<{ at: unknown }>();
  });

  it('works detached from the definition, because it is an ordinary function', () => {
    const { signal } = approval;
    const _granted = signal('approval.granted');
    expectTypeOf<SchemaInput<typeof _granted.input>['payload']>().toEqualTypeOf<{ by: string }>();
    // @ts-expect-error a detached signal still names only the declared signals
    signal('nobody.waits');
  });

  it('keeps the outcome type', () => {
    const _granted = approval.signal('approval.granted');
    expectTypeOf<Awaited<ReturnType<typeof _granted.handler>>>().toEqualTypeOf<SignalOutcome>();
  });
});

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
    expectTypeOf(refund.types).toEqualTypeOf<
      { readonly output: { holdId: string }; readonly signals: NoSignals } | undefined
    >();
  });
});
