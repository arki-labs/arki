import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { RootDb } from '../types.js';
import { initJournal } from '../journal.js';
import { j, order, OrderPlaced, tables, Unrelated } from '../test-support.js';
import { workflow } from './define.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
const Declined = defineFailure('test.declined', { status: 402, data: z.object({ reason: z.string() }) });
const Foreign = defineFailure('test.foreign', { status: 400 });

declare const db: RootDb;
const input = z.object({ orderId: z.string(), amount: z.number() });
const payInput = z.object({ amount: z.number(), reason: z.string().optional() });

const pay = j.command(
  'test.pay',
  payInput,
  { writes: [], output: z.object({ paymentId: z.string() }) },
  ({ amount }) => (amount > 0 ? { paymentId: 'p' } : Declined({ reason: 'zero' })),
);
const silent = j.command('test.silent', z.object({}), { writes: [] }, () => {
  /* returns nothing */
});
const unpay = j.command('test.unpay', z.object({ paymentId: z.string() }), { writes: [] }, () => null);

describe('j.command output, as types', () => {
  it('takes a schema of the plain result, and the failures stay out of it', () => {
    j.command('value.and.failure', z.object({}), { writes: [], output: z.object({ n: z.number() }) }, () =>
      Math.random() > 0.5 ? { n: 1 } : Declined({ reason: 'x' }),
    );
    j.command('a.promise', z.object({}), { writes: [], output: z.object({ n: z.number() }) }, () =>
      Promise.resolve({ n: 1 }),
    );
  });

  it('refuses a schema the result does not fit', () => {
    j.command(
      'wrong.output',
      z.object({}),
      // @ts-expect-error the handler returns `{ n: number }`, not `{ n: string }`
      { writes: [], output: z.object({ n: z.string() }) },
      () => ({ n: 1 }),
    );
  });
});

describe('.command, as types', () => {
  it('gives later nodes the typed result, and the mapper the typed run', () => {
    j.workflow('typed', { version: 1, input })
      .command('pay', pay, ({ input, results, runId, key }) => {
        expectTypeOf(input).toEqualTypeOf<{ orderId: string; amount: number }>();
        expectTypeOf(results).toEqualTypeOf<Readonly<Record<never, never>>>();
        expectTypeOf(runId).toBeString();
        expectTypeOf(key).toBeString();
        return { amount: input.amount };
      })
      .step('after', ({ results }) => {
        expectTypeOf(results.pay).toEqualTypeOf<{ paymentId: string }>();
      })
      .command('more', pay, ({ results }) => {
        expectTypeOf(results.pay.paymentId).toBeString();
        return { amount: 1 };
      })
      .finish();
  });

  it('a command with no output gives null; a when adds null', () => {
    j.workflow('nulls', { version: 1, input })
      .command('quiet', silent, () => ({}))
      .command('maybe', pay, ({ input }) => ({ amount: input.amount }), { when: ({ input }) => input.amount > 0 })
      .step('after', ({ results }) => {
        expectTypeOf(results.quiet).toEqualTypeOf<null>();
        expectTypeOf(results.maybe).toEqualTypeOf<{ paymentId: string } | null>();
      })
      .finish();
  });

  it('checks the input against the command, and sees no context the mapper must not use', () => {
    j.workflow('bad.input', { version: 1, input })
      // @ts-expect-error the command takes `amount`
      .command('pay', pay, () => ({ amout: 1 }));
    j.workflow('no.run', { version: 1, input }).command(
      'pay',
      pay,
      // @ts-expect-error the mapper is plain data: it cannot run a command or read the database
      ({ run }) => ({ amount: run === undefined ? 0 : 1 }),
    );
  });

  it('reads no node that has not run, and takes no name twice', () => {
    j.workflow('future', { version: 1, input }).command('pay', pay, ({ results }) => ({
      // @ts-expect-error `later` runs after this node
      amount: results.later,
    }));
    j.workflow('twice', { version: 1, input })
      .command('pay', pay, () => ({ amount: 1 }))
      // @ts-expect-error a second node named `pay`
      .command('pay', pay, () => ({ amount: 1 }));
  });

  it('takes a command of its own journal only', () => {
    const other = initJournal({ tables, meta: z.object({ tenant: z.string() }) });
    const foreign = other.command('test.other', z.object({}), { writes: [] }, () => null);
    // @ts-expect-error the command's context has another meta
    j.workflow('wrong.journal', { version: 1, input }).command('run', foreign, () => ({}));
  });

  it('accept names only failures the command returns, and each joins the typed result', () => {
    j.workflow('accepted', { version: 1, input })
      .command('pay', pay, ({ input }) => ({ amount: input.amount }), { accept: [Declined] })
      .step('after', ({ results }) => {
        expectTypeOf(results.pay).toEqualTypeOf<{ paymentId: string } | ReturnType<typeof Declined>>();
        return Declined.is(results.pay) ? results.pay.data.reason : results.pay.paymentId;
      })
      .finish();

    j.workflow('foreign.accept', { version: 1, input }).command('pay', pay, () => ({ amount: 1 }), {
      // @ts-expect-error `pay` never returns `Foreign`
      accept: [Foreign],
    });
    j.workflow('nothing.to.accept', { version: 1, input }).command('quiet', silent, () => ({}), {
      // @ts-expect-error `silent` returns no failure
      accept: [Declined],
    });
  });

  it('def.read gives the stored result typed, the accepted failure included', async () => {
    const read = await j
      .workflow('read', { version: 1, input })
      .command('pay', pay, () => ({ amount: 1 }), { accept: [Declined] })
      .step('after', () => 1)
      .finish()
      .read(db, 'r');
    if (read !== undefined && !('code' in read)) {
      expectTypeOf(read.run.results.pay).toEqualTypeOf<
        { paymentId: string } | ReturnType<typeof Declined> | undefined
      >();
      // @ts-expect-error no node has this name
      expectTypeOf(read.run.results.nope);
    }
  });

  it('undo takes its own command, and its input sees the stored result', () => {
    j.workflow('undone', { version: 1, input })
      .command('first', silent, () => ({}))
      .command('pay', pay, ({ input }) => ({ amount: input.amount }), {
        undo: {
          command: unpay,
          input: ({ input, results, result }) => {
            expectTypeOf(input).toEqualTypeOf<{ orderId: string; amount: number }>();
            expectTypeOf(results.first).toEqualTypeOf<null>();
            expectTypeOf(result).toEqualTypeOf<{ paymentId: string }>();
            return { paymentId: result.paymentId };
          },
        },
      })
      .finish();

    j.workflow('bad.undo', { version: 1, input }).command('pay', pay, () => ({ amount: 1 }), {
      undo: {
        command: unpay,
        // @ts-expect-error the undo command takes `paymentId`
        input: () => ({ payment: 'x' }),
      },
    });
  });

  it('the output is the last result, and a function gets the typed results', () => {
    const _last = j
      .workflow('last', { version: 1, input })
      .command('pay', pay, () => ({ amount: 1 }))
      .finish();
    expectTypeOf<NonNullable<typeof _last.types>['output']>().toEqualTypeOf<{ paymentId: string }>();
  });
});

describe('startOn.timing, as types', () => {
  const startInput = z.object({ orderId: z.string() });

  it('is required', () => {
    j.workflow('no.timing', {
      version: 1,
      input: startInput,
      // @ts-expect-error `timing` is required: the caller says when the run starts
      startOn: { entity: order, event: OrderPlaced, id: () => 'x', input: () => ({ orderId: 'x' }) },
    });
  });

  it('takes the two timings, and no other', () => {
    j.workflow('after', {
      version: 1,
      input: startInput,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: () => 'x',
        input: e => ({ orderId: e.entityId }),
      },
    });
    j.workflow('with', {
      version: 1,
      input: startInput,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'with-event',
        id: () => 'x',
        input: e => ({ orderId: e.entityId }),
      },
    });
    j.workflow('other', {
      version: 1,
      input: startInput,
      // @ts-expect-error not a timing
      startOn: { entity: order, event: OrderPlaced, timing: 'later', id: () => 'x', input: () => ({ orderId: 'x' }) },
    });
  });

  it("refuses onBusy 'refuse' with 'with-event', because a start in the event's transaction has nobody to refuse to", () => {
    j.workflow('refuses', {
      version: 1,
      input: startInput,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'with-event',
        id: () => 'x',
        input: () => ({ orderId: 'x' }),
      },
      // @ts-expect-error a start with the event cannot refuse
      concurrency: { total: 1, onBusy: 'refuse' },
    });
    j.workflow('queues', {
      version: 1,
      input: startInput,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'with-event',
        id: () => 'x',
        input: () => ({ orderId: 'x' }),
      },
      concurrency: { total: 1, onBusy: 'queue' },
    });
    j.workflow('refuses.after', {
      version: 1,
      input: startInput,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: () => 'x',
        input: () => ({ orderId: 'x' }),
      },
      concurrency: { total: 1, onBusy: 'refuse' },
    });
  });

  it('a standalone workflow() types its mapping like j.workflow', () => {
    workflow('standalone', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: e => {
          expectTypeOf(e.entityId).toEqualTypeOf<`ord_${string}`>();
          return e.entityId;
        },
        input: e => {
          expectTypeOf(e.data.total).toBeNumber();
          return { orderId: e.entityId, amount: e.data.total };
        },
      },
    });
    workflow('standalone.bad.data', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: () => 'x',
        // @ts-expect-error OrderPlaced has `total`, not `totl`
        input: e => ({ orderId: e.entityId, amount: e.data.totl }),
      },
    });
    workflow('standalone.bad.input', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: () => 'x',
        // @ts-expect-error the workflow's input has `amount`
        input: e => ({ orderId: e.entityId, amout: e.data.total }),
      },
    });
    workflow('standalone.bad.event', {
      version: 1,
      input,
      startOn: {
        entity: order,
        // @ts-expect-error `order` does not record `Unrelated`
        event: Unrelated,
        timing: 'after-commit',
        id: () => 'x',
        input: () => ({ orderId: 'x', amount: 1 }),
      },
    });
    workflow('standalone.refuse', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'with-event',
        id: () => 'x',
        input: () => ({ orderId: 'x', amount: 1 }),
      },
      // @ts-expect-error a start with the event cannot refuse
      concurrency: { total: 1, onBusy: 'refuse' },
    });
  });
});
