import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from '@arki/failure';

import type { RootDb } from '../types.js';
import type { RunEnding } from './define.js';
import type { RUN_STATES } from './states.js';
import { need } from '../handlers.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
// A hook's context is inferred from the definition, as a step's is: a hook that saw `unknown` for a declared output, or
// lost a need, would compile against data it does not get.
type Mailer = { send(to: string): Promise<void> };

describe('on: lifecycle hook types', () => {
  it('success sees the output schema output, the typed input and the needs; complete sees every end', () => {
    j.workflow('types.on.receipt', {
      version: 1,
      input: z.object({ orderId: z.string() }),
      output: z.object({ cents: z.int() }),
      needs: { mailer: need<Mailer>() },
      on: {
        success: ctx => {
          expectTypeOf(ctx.output).toEqualTypeOf<{ cents: number }>();
          expectTypeOf(ctx.input).toEqualTypeOf<{ orderId: string }>();
          expectTypeOf(ctx.mailer).toEqualTypeOf<Mailer>();
          expectTypeOf(ctx.state).toEqualTypeOf<'completed'>();
          expectTypeOf(ctx.db).toEqualTypeOf<RootDb>();
        },
        failure: ctx => {
          expectTypeOf(ctx.error).toEqualTypeOf<string>();
          // @ts-expect-error a failed run has no output
          void ctx.output;
        },
        complete: ctx => {
          expectTypeOf(ctx.state).toEqualTypeOf<'completed' | 'failed' | 'cancelled' | 'expired'>();
          if (ctx.state === 'completed') expectTypeOf(ctx.output).toEqualTypeOf<{ cents: number }>();
          if (ctx.state === 'failed') expectTypeOf(ctx.error).toEqualTypeOf<string>();
          expectTypeOf(ctx.tags).toEqualTypeOf<readonly string[]>();
          expectTypeOf(ctx.scope).toEqualTypeOf<string | null>();
        },
      },
    })
      .step('charge', () => ({ cents: 1 }))
      .finish();
  });

  it('without an output schema the output is unknown, the stored JSON, as def.read gives it', () => {
    j.task(
      'types.on.untyped',
      {
        version: 1,
        input: z.object({}),
        on: { success: ctx => expectTypeOf(ctx.output).toEqualTypeOf<unknown>() },
      },
      () => ({ at: new Date() }),
    );
  });

  it('a task hook gets the task needs, and a hook may return a failure', () => {
    j.task(
      'types.on.task',
      {
        version: 1,
        input: z.object({ to: z.string() }),
        needs: { mailer: need<Mailer>() },
        on: {
          success: async ctx => {
            expectTypeOf(ctx.mailer).toEqualTypeOf<Mailer>();
            await ctx.mailer.send(ctx.input.to);
          },
          cancel: (): Failure | undefined => undefined,
        },
      },
      () => 'sent',
    );
  });

  it('an unknown hook name does not compile', () => {
    j.task(
      'types.on.unknown',
      // @ts-expect-error `start` is not a lifecycle hook
      { version: 1, input: z.object({}), on: { start: () => 'started' } },
      () => 1,
    );
  });

  it('every end state is a run state', () => {
    expectTypeOf<RunEnding<unknown>['state']>().toEqualTypeOf<
      Extract<(typeof RUN_STATES)[number], 'completed' | 'failed' | 'cancelled' | 'expired'>
    >();
  });
});
