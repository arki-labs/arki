// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
import { orThrow } from '@arki/failure';

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
import { defineRelations, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppDb } from '../test-support.js';
import { adminId, core, openDb, rejectionOf, userId, users } from '../test-support.js';
import { CustomerConflict, WebhookEventNotFound } from './failures.js';
import { createCustomerId, createPlanId, createWebhookId } from './primitives.js';
import { ReferenceNotFound } from './providers/provider-error.js';
import { PaymentRepository } from './repository.js';

const relations = defineRelations(
  { customers: core.customers, plans: core.plans, webhookEvents: core.webhookEvents },
  () => ({}),
);

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
        .values({ id: orThrow(createCustomerId()), userId, providerCustomerId: 'cus_second', email: 'buyer@example.com' }),
    );

    expect(error).toMatchObject({ cause: { message: expect.stringContaining('customers_user_id_idx') } });
  });

  it('accepts the same provider customer id under another provider', async () => {
    const [row] = await db
      .insert(core.customers)
      .values({
        id: orThrow(createCustomerId()),
        userId: adminId,
        providerCustomerId: 'cus_test',
        provider: 'paypal',
        email: 'admin@example.com',
      })
      .returning();

    expect(row).toMatchObject({ provider: 'paypal', providerCustomerId: 'cus_test' });
    // Clean up: the next tests create the admin's customer themselves
    await db.delete(core.customers).where(eq(core.customers.provider, 'paypal'));
  });

  it('refuses a second row for the same provider customer under the same provider', async () => {
    const error = await rejectionOf(
      db
        .insert(core.customers)
        .values({ id: orThrow(createCustomerId()), userId: adminId, providerCustomerId: 'cus_test', email: 'admin@example.com' }),
    );

    expect(error).toMatchObject({ cause: { message: expect.stringContaining('customers_provider_customer_id_idx') } });
  });
});

describe('PaymentRepository.createCustomer', () => {
  it('returns the existing row when the same customer is created twice', async () => {
    const first = await orThrow(
      repo.createCustomer({
        id: orThrow(createCustomerId()),
        userId: adminId,
        providerCustomerId: 'cus_admin',
        email: 'admin@example.com',
      }),
    );
    const second = await orThrow(
      repo.createCustomer({
        id: orThrow(createCustomerId()),
        userId: adminId,
        providerCustomerId: 'cus_admin',
        email: 'admin@example.com',
      }),
    );

    expect(second.id).toBe(first.id);
  });

  it('returns CustomerConflict naming the stored customer when the user already has a different provider customer', async () => {
    const stored = await repo.findCustomerByUserId(userId);
    const clash = await repo.createCustomer({
      id: orThrow(createCustomerId()),
      userId,
      providerCustomerId: 'cus_other',
      email: 'buyer@example.com',
    });

    expect(CustomerConflict.is(clash)).toBe(true);
    expect(clash).toMatchObject({
      code: 'payments.customer_conflict',
      data: { userId, providerCustomerId: 'cus_other', existingCustomerId: stored?.id },
    });
    expect(await repo.findCustomerByUserId(userId)).toEqual(stored);
  });

  it('fails loudly when the provider customer belongs to another user', async () => {
    await db.insert(users).values({ id: 'usr_stranger' });

    const taken = await repo.createCustomer({
      id: orThrow(createCustomerId()),
      userId: 'usr_stranger',
      providerCustomerId: 'cus_test',
      email: 'x@example.com',
    });

    expect(taken).toMatchObject({
      code: 'payments.customer_conflict',
      data: { userId: 'usr_stranger', providerCustomerId: 'cus_test', existingCustomerId: null },
    });
    expect(await repo.findCustomerByUserId('usr_stranger')).toBeNull();
  });
});

/** An id from a router may have no row: the write returns a failure with the id and writes nothing. */
describe('PaymentRepository writes to an unknown id', () => {
  it('updatePlan and deactivatePlan return ReferenceNotFound for a plan', async () => {
    const id = orThrow(createPlanId());

    for (const result of [await repo.updatePlan(id, { name: 'x' }), await repo.deactivatePlan(id)]) {
      expect(ReferenceNotFound.is(result)).toBe(true);
      expect(result).toMatchObject({
        code: 'payments.reference_not_found',
        data: { kind: 'plan', id, missing: 'row' },
      });
    }
  });

  it('updateCustomer returns ReferenceNotFound for a customer', async () => {
    const id = orThrow(createCustomerId());

    expect(await repo.updateCustomer(id, { name: 'x' })).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'customer', id, missing: 'row' },
    });
  });

  it('the webhook event writes return WebhookEventNotFound', async () => {
    const webhookId = orThrow(createWebhookId());

    for (const result of [
      await repo.updateWebhookEvent(webhookId, { errorMessage: 'x' }),
      await repo.markWebhookEventAsProcessed(webhookId),
      await repo.incrementWebhookEventAttempts(webhookId, 'x'),
    ]) {
      expect(WebhookEventNotFound.is(result)).toBe(true);
      expect(result).toMatchObject({ code: 'payments.webhook_event_not_found', data: { webhookId } });
    }
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
