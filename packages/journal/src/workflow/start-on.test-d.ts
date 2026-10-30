import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { workflow } from './define.js';
import { j, order, OrderPlaced, ProfileOpened } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const input = z.object({ orderId: z.string(), total: z.int() });

describe('startOn is typed in the standalone workflow(), as it is in j.workflow', () => {
  it('id and input see the entity id, the event data and the entity meta', () => {
    workflow('standalone.welcome', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: event => {
          expectTypeOf(event.type).toEqualTypeOf<'OrderPlaced'>();
          expectTypeOf(event.data).toEqualTypeOf<{ customerId: string; total: number }>();
          expectTypeOf(event.entityId).toEqualTypeOf<`ord_${string}`>();
          expectTypeOf(event.meta).toEqualTypeOf<{ actorId: string }>();
          return `welcome:${event.entityId}`;
        },
        input: event => ({ orderId: event.entityId, total: event.data.total }),
      },
    });
  });

  it('j.workflow gives the same types', () => {
    j.workflow('journal.welcome', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: event => {
          expectTypeOf(event.data).toEqualTypeOf<{ customerId: string; total: number }>();
          return event.entityId;
        },
        input: event => ({ orderId: event.entityId, total: event.data.total }),
      },
    });
  });

  it('refuses an input mapping that does not fit the input schema', () => {
    workflow('standalone.bad-input', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        id: event => event.entityId,
        // @ts-expect-error total is a number in the input schema
        input: event => ({ orderId: event.entityId, total: event.data.customerId }),
      },
    });
  });

  it('refuses a field the event does not carry', () => {
    workflow('standalone.bad-field', {
      version: 1,
      input,
      startOn: {
        entity: order,
        event: OrderPlaced,
        timing: 'after-commit',
        // @ts-expect-error OrderPlaced has no `nope`
        id: event => event.data.nope,
        input: event => ({ orderId: event.entityId, total: event.data.total }),
      },
    });
  });

  it('refuses an event the entity does not record', () => {
    workflow('standalone.bad-event', {
      version: 1,
      input,
      startOn: {
        entity: order,
        // @ts-expect-error ProfileOpened belongs to the profile entity
        event: ProfileOpened,
        timing: 'after-commit',
        id: event => event.entityId,
        input: () => ({ orderId: 'x', total: 1 }),
      },
    });
  });
});
