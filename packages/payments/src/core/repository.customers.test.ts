/**
 * Customers: one per user, one per provider customer
 *
 * `findCustomerByUserId` and `findCustomerByProviderCustomerId` return one
 * row, and a checkout that finds no customer creates one. Two checkouts at
 * once must not leave two rows for a user, or make the lookups guess. The
 * unique indexes enforce it; `createCustomer` turns the second racing insert
 * into the first row instead of an error.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppDb } from '../test-support.js';
import { adminId, core, openDb, rejectionOf, userId, users } from '../test-support.js';
import { createCustomerId } from './primitives.js';
import { PaymentRepository } from './repository.js';

const relations = defineRelations({ customers: core.customers }, () => ({}));

let db: AppDb;
let client: PGlite;
let repo: PaymentRepository;

beforeAll(async () => {
  ({ db, client } = await openDb());
  repo = new PaymentRepository(drizzle({ client, relations }), core);
});

afterAll(async () => {
  await client.close();
});

describe('customers table', () => {
  it('refuses a second customer row for the same user', async () => {
    const error = await rejectionOf(
      db
        .insert(core.customers)
        .values({ id: createCustomerId(), userId, providerCustomerId: 'cus_second', email: 'buyer@example.com' }),
    );

    expect(error).toMatchObject({ cause: { message: expect.stringContaining('customers_user_id_idx') } });
  });

  it('refuses a second row for the same provider customer', async () => {
    const error = await rejectionOf(
      db
        .insert(core.customers)
        .values({ id: createCustomerId(), userId: adminId, providerCustomerId: 'cus_test', email: 'admin@example.com' }),
    );

    expect(error).toMatchObject({ cause: { message: expect.stringContaining('customers_provider_customer_id_idx') } });
  });
});

describe('PaymentRepository.createCustomer', () => {
  it('returns the existing row when the same customer is created twice', async () => {
    const first = await repo.createCustomer({
      id: createCustomerId(),
      userId: adminId,
      providerCustomerId: 'cus_admin',
      email: 'admin@example.com',
    });
    const second = await repo.createCustomer({
      id: createCustomerId(),
      userId: adminId,
      providerCustomerId: 'cus_admin',
      email: 'admin@example.com',
    });

    expect(second.id).toBe(first.id);
  });

  it('fails loudly when the user already has a different provider customer', async () => {
    const error = await rejectionOf(
      repo.createCustomer({
        id: createCustomerId(),
        userId,
        providerCustomerId: 'cus_other',
        email: 'buyer@example.com',
      }),
    );

    expect(error).toMatchObject({ message: expect.stringContaining('already has customer') });
  });

  it('fails loudly when the provider customer belongs to another user', async () => {
    await db.insert(users).values({ id: 'usr_stranger' });

    const taken = await rejectionOf(
      repo.createCustomer({
        id: createCustomerId(),
        userId: 'usr_stranger',
        providerCustomerId: 'cus_test',
        email: 'x@example.com',
      }),
    );

    expect(taken).toMatchObject({ message: 'Provider customer cus_test already belongs to another user' });
  });
});

describe('PaymentRepository counts', () => {
  it('getCustomerCount returns a number, not text', async () => {
    const total = await repo.getCustomerCount();

    expect(typeof total).toBe('number');
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('getActiveSubscriptionCount returns a number, zero when there are none', async () => {
    expect(await repo.getActiveSubscriptionCount()).toBe(0);
  });
});
