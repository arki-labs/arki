import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import { workflow } from './define.js';

const input = z.object({ amount: z.number() });
const Declined = defineFailure('typed.declined', { status: 402, data: z.object({ reason: z.string() }), message: 'declined: {reason}' });
type DeclinedFailure = ReturnType<typeof Declined>;
const charge = (amount: number) => (amount > 10 ? Declined({ reason: 'big' }) : { paid: amount });
const paid = z.object({ paid: z.number() });

describe('a step that continues on a listed failure', () => {
  it('the result is the output or the listed failure, and a later node narrows it with the definition', () => {
    workflow('t', { version: 1, input })
      .step('pay', ({ input: given }) => charge(given.amount), { output: paid, failures: [Declined], onFailure: 'continue' })
      .step('after', ({ results }) => {
        expectTypeOf(results.pay).toEqualTypeOf<{ paid: number } | DeclinedFailure>();
        return Declined.is(results.pay) ? results.pay.data.reason : results.pay.paid;
      })
      .finish();
  });

  it('without onFailure the result is the output alone', () => {
    workflow('t', { version: 1, input })
      .step('pay', ({ input: given }) => charge(given.amount), { output: paid })
      .step('after', ({ results }) => {
        expectTypeOf(results.pay).toEqualTypeOf<{ paid: number }>();
      })
      .finish();
  });

  it('onFailure needs an output schema, and a last node that can be a failure needs a finish function', () => {
    workflow('t', { version: 1, input }).step('pay', ({ input: given }) => charge(given.amount), {
      failures: [Declined],
      // @ts-expect-error -- no output schema to check the stored result with.
      onFailure: 'continue',
    });
    workflow('t', { version: 1, input })
      .step('pay', ({ input: given }) => charge(given.amount), { output: paid, failures: [Declined], onFailure: 'continue' })
      // @ts-expect-error -- a run's output is never a failure.
      .finish();
  });
});
