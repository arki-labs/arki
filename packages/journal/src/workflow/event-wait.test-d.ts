import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { AccountId, OrderId } from '../test-support.js';
import type { RecordedOf, RootDb } from '../types.js';
import { j, order, OrderNoted, OrderPaid, OrderPlaced, profile, ProfileMoved, Unrelated } from '../test-support.js';
import { workflow } from './define.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
declare const db: RootDb;
const orderIdSchema = z.templateLiteral(['ord_', z.string()]);
const accountIdSchema = z.templateLiteral(['acc_', z.string()]);
const input = z.object({ orderId: orderIdSchema, accountId: accountIdSchema });

const orderOf = (view: { readonly input: { readonly orderId: OrderId } }) => view.input.orderId;
const onPaid = { order: { entity: order, events: [OrderPaid], match: orderOf } };

type Meta = { actorId: string };
type Paid = RecordedOf<typeof OrderPaid, Meta, OrderId>;
type PaidOrNoted = RecordedOf<typeof OrderPaid | typeof OrderNoted, Meta, OrderId>;

describe('.waitFor with on, as types', () => {
  it('gives the labelled union, with the id, the meta and the data from the definitions', () => {
    const def = j
      .workflow('typed', { version: 1, input })
      .waitFor('paid', {
        on: { order: { entity: order, events: [OrderPaid, OrderNoted], match: ({ input }) => input.orderId } },
      })
      .step('next', ({ results }) => {
        expectTypeOf(results.paid).toEqualTypeOf<{ readonly via: 'order'; readonly event: PaidOrNoted }>();
        expectTypeOf(results.paid.event.entityId).toEqualTypeOf<OrderId>();
        expectTypeOf(results.paid.event.recordedAt).toEqualTypeOf<Date>();
        expectTypeOf(results.paid.event.meta).toEqualTypeOf<Meta>();
        return 1;
      })
      .finish();
    expectTypeOf(def.read(db, 'r')).toExtend<Promise<unknown>>();
  });

  it('narrows `data` by `event.type`, and the label by `via`', () => {
    j.workflow('narrow', { version: 1, input })
      .waitFor('first', {
        on: {
          order: { entity: order, events: [OrderPaid, OrderNoted], match: ({ input }) => input.orderId },
          profile: { entity: profile, events: [ProfileMoved], match: ({ input }) => input.accountId },
        },
      })
      .finish(({ results }) => {
        const { first } = results;
        if (first.via === 'profile') {
          expectTypeOf(first.event.entityId).toEqualTypeOf<AccountId>();
          return 0;
        }
        expectTypeOf(first.event.entityId).toEqualTypeOf<OrderId>();
        if (first.event.type === 'OrderPaid') {
          expectTypeOf(first.event.data).toEqualTypeOf<{ amount: number }>();
          return first.event.data.amount;
        }
        expectTypeOf(first.event.data).toEqualTypeOf<{ note: string }>();
        // @ts-expect-error `amount` is on `OrderPaid`, and this branch is `OrderNoted`
        return first.event.data.amount;
      });
  });

  it('refuses a foreign event', () => {
    j.workflow('foreign', { version: 1, input }).waitFor('w', {
      // @ts-expect-error `Unrelated` is not an event of `order`
      on: { order: { entity: order, events: [Unrelated], match: ({ input }) => input.orderId } },
    });
  });

  it('refuses a `match` that returns the wrong id type', () => {
    j.workflow('wrong-id', { version: 1, input }).waitFor('w', {
      // @ts-expect-error `order` is keyed by `OrderId`, and this is an `AccountId`
      on: { order: { entity: order, events: [OrderPaid], match: ({ input }) => input.accountId } },
    });
    j.workflow('plain-string', { version: 1, input }).waitFor('w', {
      // @ts-expect-error a plain string is no `OrderId`
      on: { order: { entity: order, events: [OrderPaid], match: () => 'ord_1' as string } },
    });
  });

  it('`where` sees the event of its own label', () => {
    j.workflow('where', { version: 1, input }).waitFor('w', {
      on: {
        order: {
          entity: order,
          events: [OrderPaid],
          match: ({ input }) => input.orderId,
          where: ({ event, input }) => {
            expectTypeOf(event).toEqualTypeOf<Paid>();
            expectTypeOf(input.accountId).toEqualTypeOf<AccountId>();
            return event.data.amount > 0;
          },
        },
        placed: {
          entity: order,
          events: [OrderPlaced],
          match: ({ input }) => input.orderId,
          // @ts-expect-error `amount` is `OrderPaid` data, and this label takes `OrderPlaced`
          where: ({ event }) => event.data.amount > 0,
        },
      },
    });
  });

  it("is `null` with `onTimeout: 'continue'` and with `when`, and never without them", () => {
    const start = () => j.workflow('nulls', { version: 1, input });
    start()
      .waitFor('hard', { on: onPaid, timeout: '1h', onTimeout: 'fail' })
      .step('s', ({ results }) => {
        expectTypeOf(results.hard).not.toBeNullable();
        return 1;
      })
      .finish();
    start()
      .waitFor('plain', { on: onPaid })
      .step('s', ({ results }) => {
        expectTypeOf(results.plain).toEqualTypeOf<{ readonly via: 'order'; readonly event: Paid }>();
        return 1;
      })
      .finish();
    start()
      .waitFor('soft', { on: onPaid, timeout: '1h', onTimeout: 'continue' })
      .step('s', ({ results }) => {
        expectTypeOf(results.soft).toEqualTypeOf<{ readonly via: 'order'; readonly event: Paid } | null>();
        // @ts-expect-error it may be `null`
        return results.soft.via;
      })
      .finish();
    start()
      .waitFor('skippable', { on: onPaid, when: ({ input }) => input.orderId !== 'ord_0' })
      .step('s', ({ results }) => {
        expectTypeOf(results.skippable).toEqualTypeOf<{ readonly via: 'order'; readonly event: Paid } | null>();
        return 1;
      })
      .finish();
  });

  it('`until` sees the results so far, and the two ways to end a wait do not mix', () => {
    j.workflow('until', { version: 1, input })
      .step('due', () => ({ at: '2026-01-01T00:00:00.000Z' }))
      .waitFor('w', {
        on: onPaid,
        until: ({ results, input }) => {
          expectTypeOf(results.due.at).toBeString();
          expectTypeOf(input.orderId).toEqualTypeOf<OrderId>();
          return new Date(results.due.at);
        },
        onTimeout: 'continue',
      })
      .finish();
    // @ts-expect-error a wait takes `timeout` or `until`, not both
    j.workflow('both', { version: 1, input }).waitFor('w', { on: onPaid, timeout: '1h', until: () => new Date() });
    // @ts-expect-error `until` must give a Date
    j.workflow('text', { version: 1, input }).waitFor('w', { on: onPaid, until: () => 'tomorrow' });
  });

  it('refuses a name already used, as every node does', () => {
    j.workflow('twice', { version: 1, input })
      .step('w', () => 1)
      // @ts-expect-error `w` is taken
      .waitFor('w', { on: onPaid });
  });

  it('def.read types the wait, and a body sees the same type', () => {
    const def = j
      .workflow('read', { version: 1, input })
      .waitFor('paid', {
        on: { order: { entity: order, events: [OrderPaid], match: ({ input }) => input.orderId } },
        timeout: '1h',
        onTimeout: 'continue',
      })
      .finish(() => 1);
    expectTypeOf(def.name).toBeString();
    type Read = Exclude<Awaited<ReturnType<typeof def.read>>, undefined | { readonly code: string }>;
    expectTypeOf<Read['run']['results']['paid']>().toEqualTypeOf<
      { readonly via: 'order'; readonly event: Paid } | null | undefined
    >();
  });

  it('types the same in a standalone workflow(): the meta comes from the entity', () => {
    workflow('standalone', { version: 1, input })
      .waitFor('paid', { on: { order: { entity: order, events: [OrderPaid], match: ({ input }) => input.orderId } } })
      .finish(({ results }) => {
        expectTypeOf(results.paid.event).toEqualTypeOf<Paid>();
        return 1;
      });
  });

  it('leaves the signal form as it was', () => {
    const def = j
      .workflow('signal', { version: 1, input })
      .waitFor('settled', { signal: 'settled', schema: z.object({ ref: z.string() }), timeout: '1h', onTimeout: 'continue' })
      .step('s', ({ results }) => {
        expectTypeOf(results.settled).toEqualTypeOf<{ ref: string } | null>();
        return 1;
      })
      .finish();
    expectTypeOf(def.signal('settled').name).toBeString();
    // @ts-expect-error no such signal
    def.signal('other');
  });

  it('a step can loop on what a wait gave: the reminder pattern', () => {
    j.workflow('reminder', { version: 1, input })
      .step('due', () => ({ at: '2026-01-01T00:00:00.000Z' }))
      .waitFor('stop', {
        on: { order: { entity: order, match: ({ input }) => input.orderId, events: [OrderPaid, OrderNoted] } },
        until: ({ results }) => new Date(results.due.at),
        onTimeout: 'continue',
      })
      .step('remind', () => 1, { next: ({ results }) => (results.stop === null ? 'due' : 'next') })
      .finish();
  });
});

describe('.sleep with next, as types', () => {
  it('takes an earlier node, `next`, or a function of the results', () => {
    j.workflow('sleep', { version: 1, input })
      .step('a', () => 1)
      .sleep('pause', '1h', { next: 'a' })
      .sleep('again', '1h', {
        next: ({ results, input }) => {
          expectTypeOf(results.a).toEqualTypeOf<number>();
          expectTypeOf(input.orderId).toEqualTypeOf<OrderId>();
          return results.a > 0 ? 'pause' : 'next';
        },
      })
      .finish();
  });

  it('refuses a node that is not earlier', () => {
    j.workflow('later', { version: 1, input })
      .step('a', () => 1)
      // @ts-expect-error `b` is no earlier node
      .sleep('pause', '1h', { next: 'b' })
      .step('b', () => 2);
    j.workflow('later-fn', { version: 1, input })
      .step('a', () => 1)
      // @ts-expect-error `b` is no earlier node
      .sleep('pause', '1h', { next: () => 'b' });
  });
});
