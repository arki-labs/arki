import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import type { SchemaInput } from '@arki/schema';

import type { WorkflowDef } from './define.js';
import { need } from '../handlers.js';
import { workflow } from './define.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
const base = () => workflow('refund', { version: 1, input: z.object({ paymentId: z.string(), amount: z.number() }) });
type OutputOf<Def extends WorkflowDef> = NonNullable<Def['types']>['output'];

describe('the workflow builder, as types', () => {
  it('results accumulate with the exact type each step returned', () => {
    base()
      .step('hold', () => ({ holdId: 'h1', amount: 5 }))
      .step('payBack', ({ results }) => {
        expectTypeOf(results).toEqualTypeOf<{ readonly hold: { holdId: string; amount: number } }>();
        return Promise.resolve({ providerId: 'p1' });
      })
      .step('notify', ({ results }) => {
        expectTypeOf(results).toEqualTypeOf<{
          readonly hold: { holdId: string; amount: number };
          readonly payBack: { providerId: string };
        }>();
        return null;
      });
  });

  it('a returned Failure is not part of the result', () => {
    const failed = null as unknown as Failure;
    base()
      .step('hold', () => (Math.random() > 0.5 ? { holdId: 'h1' } : failed))
      .step('next', ({ results }) => {
        expectTypeOf(results.hold).toEqualTypeOf<{ holdId: string }>();
        return 1;
      });
  });

  it('input comes from the schema output', () => {
    workflow('t', { version: 1, input: z.object({ id: z.string().default('x'), n: z.coerce.number() }) }).step(
      'a',
      ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string; n: number }>();
        return 1;
      },
    );
  });

  it('a step with when is R | null downstream, and a step without it is R', () => {
    base()
      .step('hold', () => ({ holdId: 'h1' }), { when: ({ input }) => input.amount > 0 })
      .step('after', ({ results }) => {
        expectTypeOf(results.hold).toEqualTypeOf<{ holdId: string } | null>();
        return 1;
      })
      .step('last', ({ results }) => {
        expectTypeOf(results.after).toEqualTypeOf<number>();
        return 1;
      });
  });

  it('undo, key and next get the types of the step they belong to', () => {
    base()
      .step('gate', () => ({ done: false }))
      .step('hold', ({ results }) => ({ holdId: results.gate.done ? 'a' : 'b' }), {
        undo: ({ result, results, input }) => {
          expectTypeOf(result).toEqualTypeOf<{ holdId: string }>();
          expectTypeOf(results.gate).toEqualTypeOf<{ done: boolean }>();
          expectTypeOf(input.paymentId).toEqualTypeOf<string>();
        },
        key: ({ input }) => input.paymentId,
        next: ({ result }) => {
          expectTypeOf(result).toEqualTypeOf<{ holdId: string }>();
          return result.holdId === 'a' ? 'next' : 'gate';
        },
      });
  });

  it('next may name an earlier step or "next", and nothing else', () => {
    base()
      // @ts-expect-error the first step has no earlier node
      .step('first', () => 1, { next: () => 'first' })
      .step('second', () => 2, { next: 'first' })
      // @ts-expect-error `later` is not defined yet, so it cannot be a target
      .step('third', () => 3, { next: () => 'later' })
      // @ts-expect-error a step cannot jump to itself
      .step('fourth', () => 4, { next: 'fourth' })
      // @ts-expect-error an unknown name is not a node
      .step('fifth', () => 5, { next: 'nowhere' })
      .step('sixth', () => 6, { next: () => 'next' });
  });

  it('a step name cannot repeat', () => {
    base()
      .step('a', () => 1)
      // @ts-expect-error `a` is already a node
      .step('a', () => 2);
  });

  it('an output schema must produce the step result', () => {
    base().step('hold', () => ({ holdId: 'h1' }), { output: z.object({ holdId: z.string() }) });
    // @ts-expect-error the schema says holdId is a number
    base().step('hold', () => ({ holdId: 'h1' }), { output: z.object({ holdId: z.number() }) });
  });

  // Most real steps return a promise: the result is its awaited value, and the schema is only checked against it.
  it('a step that returns a promise takes an output schema, which must produce the awaited result', () => {
    base()
      .step('charge', () => Promise.resolve({ chargeId: 'c1' }), { output: z.object({ chargeId: z.string() }) })
      .step('notify', ({ results }) => {
        expectTypeOf(results.charge).toEqualTypeOf<{ chargeId: string }>();
        return null;
      });
    base().step('charge', ({ input }) => Promise.resolve({ chargeId: input.paymentId }), {
      output: z.object({ chargeId: z.string() }),
      undo: ({ result }) => expectTypeOf(result).toEqualTypeOf<{ chargeId: string }>(),
    });
    // @ts-expect-error the schema says chargeId is a number, the body resolves to a string
    base().step('charge', () => Promise.resolve({ chargeId: 'c1' }), { output: z.object({ chargeId: z.number() }) });
  });

  it('services listed in needs are on the context', () => {
    type Provider = { refund(id: string): Promise<{ id: string }> };
    workflow('t', { version: 1, input: z.object({ id: z.string() }), needs: { provider: need<Provider>() } }).step(
      'pay',
      async ({ provider, input }) => {
        expectTypeOf(provider).toEqualTypeOf<Provider>();
        return await provider.refund(input.id);
      },
    );
  });

  it('waitFor gives the signal payload, or null when the timeout continues', () => {
    base()
      .waitFor('settled', { signal: 's', schema: z.object({ id: z.string() }), timeout: '3d' })
      .waitFor('later', { signal: 'l', schema: z.object({ ok: z.boolean() }), timeout: '1d', onTimeout: 'continue' })
      .step('after', ({ results }) => {
        expectTypeOf(results.settled).toEqualTypeOf<{ id: string }>();
        expectTypeOf(results.later).toEqualTypeOf<{ ok: boolean } | null>();
        return 1;
      });
  });

  it('a waitFor with when is payload | null downstream, and one without it is the payload', () => {
    base()
      .waitFor('settled', { signal: 's', schema: z.object({ id: z.string() }) })
      .waitFor('approved', {
        signal: 'a',
        schema: z.object({ by: z.string() }),
        // `when` sees the context of the nodes before it, typed.
        when: ({ input, results }) => {
          expectTypeOf(input.amount).toBeNumber();
          expectTypeOf(results.settled).toEqualTypeOf<{ id: string }>();
          return input.amount > 100;
        },
      })
      .step('after', ({ results }) => {
        expectTypeOf(results.settled).toEqualTypeOf<{ id: string }>();
        expectTypeOf(results.approved).toEqualTypeOf<{ by: string } | null>();
        return 1;
      });
  });

  it('waitFor adds its signal and payload schema to the definition, so a sender cannot name another signal', () => {
    const accepted = z.object({ id: z.string() });
    const _def = base()
      .waitFor('settled', { signal: 'a', schema: accepted })
      .waitFor('later', { signal: 'b', schema: z.object({ ok: z.boolean() }) })
      .finish();
    type Signals = NonNullable<typeof _def.types>['signals'];
    expectTypeOf<keyof Signals>().toEqualTypeOf<'a' | 'b'>();
    expectTypeOf<Signals['a']>().toEqualTypeOf<typeof accepted>();
    expectTypeOf<SchemaInput<Signals['b']>>().toEqualTypeOf<{ ok: boolean }>();
  });

  it('a workflow with no waitFor declares no signal', () => {
    const _def = base()
      .step('a', () => 1)
      .finish();
    expectTypeOf<keyof NonNullable<typeof _def.types>['signals']>().toEqualTypeOf<never>();
  });

  it('sleep leaves null in results', () => {
    base()
      .sleep('cool', '24h')
      .sleep('until', ({ input }) => new Date(input.amount))
      .step('after', ({ results }) => {
        expectTypeOf(results.cool).toEqualTypeOf<null>();
        expectTypeOf(results.until).toEqualTypeOf<null>();
        return 1;
      });
  });

  it('a child result is the child workflow output, and its input is checked', () => {
    const ledger = workflow('ledger', { version: 1, input: z.object({ refundId: z.string() }) })
      .step('post', () => ({ entryId: 'e1' }))
      .finish(({ results }) => ({ entryId: results.post.entryId }));

    base()
      .step('hold', () => ({ holdId: 'h1' }))
      .child('ledger', ledger, { input: ({ results }) => ({ refundId: results.hold.holdId }) })
      .child('again', ({ results }) => (results.hold.holdId ? ledger : ledger), {
        input: () => ({ refundId: 'x' }),
        onCancel: 'detach',
      })
      .step('after', ({ results }) => {
        expectTypeOf(results.ledger).toEqualTypeOf<{ entryId: string }>();
        expectTypeOf(results.again).toEqualTypeOf<{ entryId: string }>();
        return 1;
      });

    // @ts-expect-error the child needs a string refundId
    base().child('ledger', ledger, { input: () => ({ refundId: 1 }) });
  });

  it('a child undo gets the child output as result', () => {
    const ledger = workflow('ledger', { version: 1, input: z.object({ refundId: z.string() }) })
      .step('post', () => ({ entryId: 'e1' }))
      .finish(({ results }) => ({ entryId: results.post.entryId }));
    base().child('ledger', ledger, {
      input: () => ({ refundId: 'x' }),
      undo: ({ result }) => {
        expectTypeOf(result).toEqualTypeOf<{ entryId: string }>();
      },
    });
    base().child('ledger', ledger, {
      input: () => ({ refundId: 'x' }),
      // @ts-expect-error the child output has no refundId
      undo: ({ result }) => result.refundId,
    });
  });

  it('a map input must return the item workflow input, and gets the item and its index', () => {
    const item = workflow('item', { version: 1, input: z.object({ id: z.string() }) })
      .step('work', ({ input }) => ({ done: input.id }))
      .finish();
    workflow('batch', { version: 1, input: z.object({ ids: z.array(z.string()) }) }).map('all', item, {
      items: ({ input }) => input.ids,
      input: (_ctx, id, index) => {
        expectTypeOf(index).toEqualTypeOf<number>();
        return { id };
      },
    });
    workflow('batch', { version: 1, input: z.object({ ids: z.array(z.string()) }) }).map('all', item, {
      items: ({ input }) => input.ids,
      // @ts-expect-error the item workflow needs a string id
      input: () => ({ id: 1 }),
    });
  });

  it('a map result is an array of the item result, or one item result with wait any', () => {
    const item = workflow('item', { version: 1, input: z.object({ id: z.string() }) })
      .step('work', ({ input }) => ({ done: input.id }))
      .finish();
    workflow('batch', { version: 1, input: z.object({ ids: z.array(z.string()) }) })
      .map('all', item, {
        items: ({ input }) => input.ids,
        input: (_ctx, id) => {
          expectTypeOf(id).toEqualTypeOf<string>();
          return { id };
        },
      })
      .map('first', item, { items: ({ input }) => input.ids, input: (_ctx, id) => ({ id }), wait: 'any' })
      .step('after', ({ results }) => {
        expectTypeOf(results.all).toEqualTypeOf<{ done: string }[]>();
        expectTypeOf(results.first).toEqualTypeOf<{ done: string }>();
        return 1;
      });
  });

  it('only a step takes an undo', () => {
    // @ts-expect-error sleep has no undo
    base().sleep('cool', '1h', { undo: () => 0 });
    // @ts-expect-error waitFor has no undo
    base().waitFor('w', { signal: 's', schema: z.string(), undo: () => 0 });
  });

  it('finish() gives the last node result, finish(fn) gives what fn returns', () => {
    const last = base()
      .step('hold', () => ({ holdId: 'h1' }))
      .step('pay', () => ({ providerId: 'p' }), { when: () => true })
      .finish();
    expectTypeOf(last).toExtend<WorkflowDef>();
    expectTypeOf<OutputOf<typeof last>>().toEqualTypeOf<{ providerId: string } | null>();

    const mapped = base()
      .step('hold', () => ({ holdId: 'h1' }))
      .finish(({ results, input }) => Promise.resolve({ id: results.hold.holdId, amount: input.amount }));
    expectTypeOf(mapped).toExtend<WorkflowDef>();
    expectTypeOf<OutputOf<typeof mapped>>().toEqualTypeOf<{ id: string; amount: number }>();
  });

  it('with an output schema, finish returns that schema output', () => {
    const def = workflow('t', {
      version: 1,
      input: z.object({ id: z.string() }),
      output: z.object({ total: z.number() }),
    })
      .step('sum', () => ({ total: 3 }))
      .finish(({ results }) => results.sum);
    expectTypeOf(def).toExtend<WorkflowDef>();
    expectTypeOf<OutputOf<typeof def>>().toEqualTypeOf<{ total: number }>();

    workflow('t', { version: 1, input: z.object({ id: z.string() }), output: z.object({ total: z.number() }) })
      .step('sum', () => ({ total: 3 }))
      // @ts-expect-error the output schema wants a number total
      .finish(() => ({ total: 'x' }));
  });

  it('the definition keeps the input schema, so a parent can read its input type', () => {
    const def = base()
      .step('a', () => 1)
      .finish();
    expectTypeOf(def.input).toExtend<z.ZodType>();
    expectTypeOf(def.shapeHash).toEqualTypeOf<string>();
  });
});
