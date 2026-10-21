import type { CommandFailure } from '../errors.js';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { SchemaInput, SchemaOutput } from '@arki/schema';

import type { CommandConflict } from '../errors.js';
import type { NoNeeds } from '../types.js';
import type { NoSignals } from './define.js';
import type { CancelOutcome, SignalOutcome } from './runner.js';
import type { SignalStatus } from './states.js';
import { j, order } from '../test-support.js';

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
    expectTypeOf<Awaited<ReturnType<typeof _granted.handler>>>().toEqualTypeOf<SignalOutcome | CommandFailure>();
  });

  it('can report no-run, so a webhook handler must not treat an unknown run as an error', () => {
    const _granted = approval.signal('approval.granted');
    type Delivered = Extract<Awaited<ReturnType<typeof _granted.handler>>, { readonly status: SignalStatus }>;
    expectTypeOf<Delivered['status']>().toEqualTypeOf<'kept' | 'woke' | 'duplicate' | 'finished' | 'no-run'>();
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
      { readonly runId: string } | CommandConflict | CommandFailure
    >();
  });

  it('a workflow keeps its output type next to start', () => {
    expectTypeOf(refund.name).toBeString();
    expectTypeOf(refund.types).toEqualTypeOf<
      | {
          readonly output: { holdId: string };
          readonly signals: NoSignals;
          readonly needs: NoNeeds;
          // No `output` schema and no checked step: `def.read` gives the output and `hold` as `unknown`.
          readonly readOutput: unknown;
          readonly results: { readonly hold?: unknown };
        }
      | undefined
    >();
  });
});

describe('def.cancel, as types', () => {
  it('takes the run id, a reason and an optional Foreman execution id', () => {
    expectTypeOf<SchemaInput<typeof refund.cancel.input>>().toEqualTypeOf<{
      readonly runId: string;
      readonly reason: string;
      readonly executionId?: string | undefined;
    }>();
  });

  it('returns the state the run is in, or a refusal', () => {
    expectTypeOf<Awaited<ReturnType<typeof refund.cancel.handler>>>().toEqualTypeOf<CancelOutcome | CommandFailure>();
  });

  it('gives an undo the result of its own step, not of another', () => {
    j.workflow('undone', { version: 1, input: z.object({}) })
      .step('charge', () => ({ chargeId: 'c1' }), {
        undo: ({ result }) => {
          expectTypeOf(result).toEqualTypeOf<{ chargeId: string }>();
        },
      })
      .step('reserve', () => ({ slot: 7 }), {
        undo: ({ result, results }) => {
          expectTypeOf(result).toEqualTypeOf<{ slot: number }>();
          expectTypeOf(results.charge).toEqualTypeOf<{ chargeId: string }>();
        },
      })
      .finish();
  });
});

describe('ctx.run in a workflow body, as types', () => {
  const ping = j.command('ping', z.object({ n: z.number() }), () => 'pong');

  it("may leave the meta out in a workflow body: the app's workflowMeta is used", () => {
    j.workflow('pinger', { version: 1, input: z.object({}) })
      .step('ping', async ({ run }) => {
        expectTypeOf(await run(ping, { n: 1 })).toEqualTypeOf<string | CommandFailure>();
        // A meta passed by the body is still checked against the app's meta schema.
        expectTypeOf(run(ping, { n: 1 }, { actorId: 'usr_1' })).resolves.toEqualTypeOf<string | CommandFailure>();
        // @ts-expect-error the app's meta has `actorId`, not `actor`
        expectTypeOf(run(ping, { n: 1 }, { actor: 'usr_1' })).resolves.toEqualTypeOf<string | CommandFailure>();
        return 1;
      })
      .finish();
  });

  it("still needs the meta in an effect's ctx.run (RootCommandRunner), where no app choice stands in for it", () => {
    j.effect('pinged', order, {
      OrderPlaced: (_event, { run }) => {
        expectTypeOf(run(ping, { n: 1 }, { actorId: 'usr_1' })).resolves.toEqualTypeOf<string | CommandFailure>();
        // @ts-expect-error an effect names its actor: the meta is required
        expectTypeOf(run(ping, { n: 1 })).resolves.toEqualTypeOf<string | CommandFailure>();
      },
    });
  });
});
