import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DB_COMPOSITION_ERROR_CODES,
  DbCompositionError,
  composeSchema,
  createUnitOfWork,
} from './composition.js';
import type { TransactionalDb } from './composition.js';

describe('composeSchema', () => {
  it('returns one exact schema object from feature-owned slices', () => {
    const users = { users: { tableName: 'users' } } as const;
    const orders = { orders: { tableName: 'orders' } } as const;

    const schema = composeSchema(users, orders);

    expect(schema).toEqual({
      users: { tableName: 'users' },
      orders: { tableName: 'orders' },
    });
    expectTypeOf(schema.users.tableName).toEqualTypeOf<'users'>();
    expectTypeOf(schema.orders.tableName).toEqualTypeOf<'orders'>();
  });

  it('rejects duplicate schema keys at compile time and runtime', () => {
    const users = { users: { tableName: 'users' } } as const;
    const duplicateUsers = { users: { tableName: 'duplicate_users' } } as const;

    expect(() => {
      // @ts-expect-error — duplicate schema keys must be rejected before drizzle-kit sees the object
      composeSchema(users, duplicateUsers);
    }).toThrow(DbCompositionError);

    try {
      // @ts-expect-error — same duplicate-key call; the runtime error shape is the assertion target here
      composeSchema(users, duplicateUsers);
      expect.unreachable('duplicate schema key must throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: DB_COMPOSITION_ERROR_CODES.duplicateSchemaKey,
        message: expect.stringContaining('users'),
      });
    }
  });
});

describe('createUnitOfWork', () => {
  type Tx = {
    readonly events: string[];
  };

  it('builds typed feature transaction scopes over one db.transaction call', async () => {
    let capturedTx: Tx | undefined;
    const db: TransactionalDb<Tx> = {
      async transaction<TResult>(fn: (tx: Tx) => Promise<TResult>): Promise<TResult> {
        const tx = { events: [] };
        capturedTx = tx;
        return fn(tx);
      },
    };

    const uow = createUnitOfWork(db, {
      orders: tx => ({
        create(id: string) {
          tx.events.push(`order:${id}`);
        },
      }),
      billing: tx => ({
        charge(cents: number) {
          tx.events.push(`charge:${String(cents)}`);
        },
      }),
    });

    const result = await uow(tx => {
      type OrdersCreate = (typeof tx.orders)['create'];
      type BillingCharge = (typeof tx.billing)['charge'];
      expectTypeOf<OrdersCreate>().parameter(0).toEqualTypeOf<string>();
      expectTypeOf<BillingCharge>().parameter(0).toEqualTypeOf<number>();
      // @ts-expect-error — only declared feature scopes are available in the transaction callback
      void tx.inventory;

      tx.orders.create('ord_1');
      tx.billing.charge(500);
      return 'committed' as const;
    });

    expect(result).toBe('committed');
    expect(capturedTx?.events).toEqual(['order:ord_1', 'charge:500']);
  });
});
