// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
import { instant } from '@arki/date';
import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';

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
import type { NewPlan } from './types.js';
import { runnerOn } from '../service-test-support.js';
import { adminId, core, meta, openDb, plain, rejectionOf, typed, userId, users } from '../test-support.js';
import { CustomerConflict, WebhookEventNotFound } from './failures.js';
import { createCustomerId, createPlanId, createWebhookId } from './primitives.js';
import { ReferenceNotFound } from './providers/provider-error.js';
import { INT4_MAX, pgJsonRecordSchema, pgJsonSchema } from './pg-values.js';
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

describe('PaymentRepository writes refuse what the columns cannot hold, as typed failures', () => {
  const plan = (overrides: Partial<NewPlan> = {}): NewPlan => ({ id: orThrow(createPlanId()), name: 'Team', priceMinor: 1500, ...overrides });

  const refusedPlans: [string, Partial<NewPlan>][] = [
    ['a negative price', { priceMinor: -1 }],
    ['a fractional price', { priceMinor: 1.5 }],
    ['a currency outside ISO 4217', { currency: 'ZZZ' }],
    ['a name past 255 characters', { name: 'n'.repeat(256) }],
    ['U+0000 in the name', { name: 'Te\u0000am' }],
    ['U+0000 in a feature', { features: ['ok', 'b\u0000d'] }],
    ['an interval count past the integer range', { intervalCount: 2 ** 31 }],
  ];

  it.each(refusedPlans)('createPlan refuses %s as schema.invalid_input and stores nothing', async (_what, overrides) => {
    const data = plan(overrides);

    expect(await repo.createPlan(data)).toMatchObject({ code: 'schema.invalid_input' });
    expect(await repo.findPlanById(data.id ?? orThrow(createPlanId()))).toBeNull();
  });

  it('createPlan returns plan_already_exists for a stored id, and updatePlan refuses U+0000', async () => {
    const stored = orThrow(await repo.createPlan(plan()));

    expect(await repo.createPlan(plan({ id: stored.id }))).toMatchObject({
      code: 'payments.plan_already_exists',
      data: { planId: stored.id },
    });
    expect(await repo.updatePlan(stored.id, { description: 'x\u0000' })).toMatchObject({ code: 'schema.invalid_input' });
  });

  it('createCustomer and updateCustomer return reference_not_found for a user with no row', async () => {
    expect(
      await repo.createCustomer({ userId: 'usr_ghost', providerCustomerId: 'cus_ghost', email: 'ghost@example.com' }),
    ).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'user', id: 'usr_ghost', missing: 'row' } });

    const [owned] = await db.select().from(core.customers).where(eq(core.customers.userId, userId));
    if (!owned) throw new Error('the fixture user has a customer');
    expect(await repo.updateCustomer(owned.id, { userId: 'usr_ghost' })).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'user', id: 'usr_ghost' },
    });
  });

  it('createCustomer refuses an email past 255 characters and U+0000 in the name', async () => {
    const owner = 'usr_long_email';
    await db.insert(users).values({ id: owner });

    expect(
      await repo.createCustomer({ userId: owner, providerCustomerId: 'cus_long', email: `${'a'.repeat(250)}@example.com` }),
    ).toMatchObject({ code: 'schema.invalid_input' });
    expect(
      await repo.createCustomer({ userId: owner, providerCustomerId: 'cus_nul', email: 'nul@example.com', name: 'N\u0000' }),
    ).toMatchObject({ code: 'schema.invalid_input' });
  });

  it('updateCustomer refuses an email past 255 characters and U+0000 in the name, and writes nothing', async () => {
    const owner = 'usr_update_refused';
    await db.insert(users).values({ id: owner });
    const customer = orThrow(
      await repo.createCustomer({ userId: owner, providerCustomerId: 'cus_update_refused', email: 'kept@example.com' }),
    );

    expect(await repo.updateCustomer(customer.id, { email: `${'a'.repeat(250)}@example.com` })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await repo.updateCustomer(customer.id, { name: 'N\u0000' })).toMatchObject({ code: 'schema.invalid_input' });
    expect(await repo.findCustomerById(customer.id)).toMatchObject({ email: 'kept@example.com', name: null });
  });

  it('updateCustomer returns customer_conflict for a user or provider customer another customer holds', async () => {
    const first = 'usr_conflict_a';
    const second = 'usr_conflict_b';
    await db.insert(users).values([{ id: first }, { id: second }]);
    const a = orThrow(await repo.createCustomer({ userId: first, providerCustomerId: 'cus_conflict_a', email: 'a@example.com' }));
    const b = orThrow(await repo.createCustomer({ userId: second, providerCustomerId: 'cus_conflict_b', email: 'b@example.com' }));

    expect(await repo.updateCustomer(b.id, { userId: first })).toMatchObject({
      code: 'payments.customer_conflict',
      data: { userId: first, existingCustomerId: a.id },
    });
    expect(await repo.updateCustomer(b.id, { providerCustomerId: 'cus_conflict_a' })).toMatchObject({
      code: 'payments.customer_conflict',
      data: { providerCustomerId: 'cus_conflict_a', existingCustomerId: null },
    });
    expect(await repo.findCustomerById(b.id)).toMatchObject({ userId: second, providerCustomerId: 'cus_conflict_b' });
  });

  it('deleteCustomer returns customer_in_use while a refund points at one of its payments, and deletes nothing', async () => {
    const owner = 'usr_refunded';
    await db.insert(users).values({ id: owner });
    const customer = orThrow(await repo.createCustomer({ userId: owner, providerCustomerId: 'cus_refunded', email: 'r@example.com' }));
    const writes = typed.core.writes(runnerOn(db));
    const payment = orThrow(
      await writes.initiatePayment({ userId: owner, customerId: customer.id, providerPaymentId: 'pi_refunded', amount: { amount: '20', currency: 'USD' } }),
    );
    orThrow(await writes.completePayment({ paymentId: payment.id }));
    orThrow(
      await plain.journal.run(
        db,
        plain.refunds.commands.requestRefund,
        {
          paymentId: payment.id,
          originalAmount: { amount: '20', currency: 'USD' },
          refundAmount: { amount: '5', currency: 'USD' },
          reason: 'customer_request',
          requestedBy: owner,
        },
        meta,
      ),
    );

    expect(await repo.deleteCustomer(customer.id)).toMatchObject({
      code: 'payments.customer_in_use',
      data: { customerId: customer.id },
    });
    expect(await repo.findCustomerById(customer.id)).not.toBeNull();
  });

  it('webhook event writes refuse a taken provider event id and U+0000 in text', async () => {
    const first = orThrow(await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_taken', data: {} }));
    const other = orThrow(await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_other', data: {} }));

    expect(
      await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_taken', data: {} }),
    ).toMatchObject({ code: 'payments.webhook_event_exists', data: { providerEventId: 'evt_taken' } });
    expect(await repo.updateWebhookEvent(other.id, { providerEventId: 'evt_taken' })).toMatchObject({
      code: 'payments.webhook_event_exists',
    });
    expect(await repo.updateWebhookEvent(first.id, { errorMessage: 'x\u0000' })).toMatchObject({ code: 'schema.invalid_input' });
    expect(await repo.incrementWebhookEventAttempts(first.id, 'x\u0000')).toMatchObject({ code: 'schema.invalid_input' });
    expect(
      await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_nul', data: { n: '\u0000' } }),
    ).toMatchObject({ code: 'schema.invalid_input' });
  });
});

describe('jsonb values refuse a lone surrogate, which Postgres refuses with 22P02', () => {
  const lone = ['\uD800', 'a\uDC00', 'x\uD83D', '\uDFFF\uD800'];

  it('pgJsonSchema and pgJsonRecordSchema refuse a lone surrogate in a string or key, and keep a real pair', () => {
    for (const text of lone) {
      expect(pgJsonSchema.safeParse(text).success).toBe(false);
      expect(pgJsonSchema.safeParse([{ deep: text }]).success).toBe(false);
      expect(pgJsonRecordSchema.safeParse({ note: text }).success).toBe(false);
      expect(pgJsonRecordSchema.safeParse({ [text]: 1 }).success).toBe(false);
    }
    expect(pgJsonRecordSchema.safeParse({ emoji: '\uD83D\uDE00', key: 'plain' }).success).toBe(true);
    expect(pgJsonSchema.safeParse('\uD83D\uDE00').success).toBe(true);
  });

  it('createWebhookEvent refuses it as schema.invalid_input and store nothing; a real pair is stored', async () => {
    expect(
      await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_lone', data: { n: '\uD800' } }),
    ).toMatchObject({ code: 'schema.invalid_input' });
    expect(await repo.findWebhookEventByProviderEventId('evt_lone', 'stripe')).toBeNull();

    const kept = orThrow(
      await repo.createWebhookEvent({ provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_pair', data: { n: '\uD83D\uDE00' } }),
    );
    expect(kept.data).toEqual({ n: '\uD83D\uDE00' });
  });
});

describe('PaymentRepository reads with values no row can hold', () => {
  it('a lookup by a provider id with U+0000 or past 255 characters finds nothing', async () => {
    for (const id of ['cus_\u0000', 'x'.repeat(256)]) {
      expect(await repo.findCustomerByProviderCustomerId(id, 'stripe')).toBeNull();
      expect(await repo.findSubscriptionByProviderSubscriptionId(id)).toBeNull();
      expect(await repo.findPaymentByProviderPaymentId(id)).toBeNull();
      expect(await repo.findWebhookEventByProviderEventId(id, 'stripe')).toBeNull();
    }
  });

  it('a lookup by a value outside a pgEnum column answers empty or null, never a raw 22P02 or 22021', async () => {
    // JSON.parse is typed `any`, the way an untyped caller reaches these methods with a value outside the enum
    const outside = JSON.parse('"\\u0000"');
    const long = JSON.parse(`"${'x'.repeat(300)}"`);

    expect(await repo.findPlansByTier(outside)).toEqual([]);
    expect(await repo.findSubscriptionsByStatus(long)).toEqual([]);
    expect(await repo.findSubscriptionsEndingInRange(instant('2026-01-01T00:00:00Z'), instant('2026-02-01T00:00:00Z'), outside)).toEqual([]);
    expect(await repo.findPaymentsByStatus(outside)).toEqual([]);
    expect(await repo.findWebhookEventsByType(long)).toEqual([]);
    expect(await repo.findCustomerByProviderCustomerId('cus_1', outside)).toBeNull();
    expect(await repo.findWebhookEventByProviderEventId('evt_1', long)).toBeNull();
  });

  it('claimWebhookEvent returns schema.invalid_input for a provider or event type outside its enum, and writes nothing', async () => {
    const outside = JSON.parse('"\\u0000"');
    const base = { providerEventId: 'evt_enum_claim', data: {} };

    expect(await repo.claimWebhookEvent({ ...base, provider: outside, eventType: 'subscription.created' })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await repo.claimWebhookEvent({ ...base, provider: 'stripe', eventType: outside })).toMatchObject({
      code: 'schema.invalid_input',
    });
    expect(await repo.findWebhookEventByProviderEventId('evt_enum_claim', 'stripe')).toBeNull();
  });

  it('a belowAttempts past the 32-bit range matches every event instead of a raw 22003', async () => {
    const created = orThrow(await repo.createWebhookEvent({ provider: 'stripe', eventType: 'subscription.created', providerEventId: 'evt_big_attempts', data: {} }));

    const events = await repo.findUnprocessedWebhookEvents(1000, 2 ** 31);

    expect(events.map(event => event.id)).toContain(created.id);
  });

  // The `attempts + 1` of both doors failed with a raw SQLSTATE 22003 on a full count before
  it('an event whose attempts count is full returns payments.counter_exhausted from both increments and writes nothing', async () => {
    const full = orThrow(
      await repo.createWebhookEvent({
        provider: 'stripe',
        eventType: 'subscription.created',
        providerEventId: 'evt_full_attempts',
        data: {},
        attempts: INT4_MAX,
        errorMessage: 'the last attempt failed',
      }),
    );
    const exhausted = { code: 'payments.counter_exhausted', data: { counter: 'attempts', id: full.id } };

    expect(await repo.incrementWebhookEventAttempts(full.id, 'once more')).toMatchObject(exhausted);
    expect(await repo.reclaimWebhookEvent(full.id, INT4_MAX, instant('2026-01-01T00:00:00Z'))).toMatchObject(exhausted);
    expect(await repo.findWebhookEventById(full.id)).toEqual(full);
    // An id no event has is still not found, and a count that is not full still goes up
    expect(WebhookEventNotFound.is(await repo.incrementWebhookEventAttempts(orThrow(createWebhookId())))).toBe(true);
    expect(await repo.reclaimWebhookEvent(orThrow(createWebhookId()), INT4_MAX, instant('2026-01-01T00:00:00Z'))).toBe(false);
    const below = orThrow(
      await repo.createWebhookEvent({
        provider: 'stripe',
        eventType: 'subscription.created',
        providerEventId: 'evt_almost_full_attempts',
        data: {},
        attempts: INT4_MAX - 1,
      }),
    );
    expect(await repo.incrementWebhookEventAttempts(below.id)).toMatchObject({ attempts: INT4_MAX });
  });

  it('a time outside the years 1 to 9999 or a fractional count breaks a stated precondition', async () => {
    const ancient = instant('-000100-01-01T00:00:00Z');
    const invariantBroken = { code: FAILURE_ERROR_CODES.invariant };

    await expect(repo.countPaymentsCreatedBetween(ancient, instant('2026-01-01T00:00:00Z'))).rejects.toMatchObject(invariantBroken);
    await expect(repo.getPaymentStats(ancient)).rejects.toMatchObject(invariantBroken);
    await expect(repo.getSubscriptionStats(undefined, ancient)).rejects.toMatchObject(invariantBroken);
    await expect(repo.findSubscriptionsEndingInRange(ancient, ancient)).rejects.toMatchObject(invariantBroken);
    await expect(repo.findPaymentsByUserId(userId, 1.5)).rejects.toMatchObject(invariantBroken);
    await expect(repo.findUnprocessedWebhookEvents(0.5)).rejects.toMatchObject(invariantBroken);
    await expect(repo.reclaimWebhookEvent(orThrow(createWebhookId()), 0.5, instant('2026-01-01T00:00:00Z'))).rejects.toMatchObject(invariantBroken);
  });

  it('a list query its contract schema refuses breaks the stated precondition before any query', async () => {
    const invariantBroken = { code: FAILURE_ERROR_CODES.invariant };

    await expect(repo.findPlans({ limit: 1.5, offset: 0 })).rejects.toMatchObject(invariantBroken);
    await expect(repo.findSubscriptions({ limit: 20, offset: Number.NaN })).rejects.toMatchObject(invariantBroken);
    await expect(
      repo.findPayments({ limit: 20, offset: 0, startDate: instant('-000100-01-01T00:00:00Z') }),
    ).rejects.toMatchObject(invariantBroken);
  });

  it('an id or user id holding U+0000 finds nothing and sends no query, as a provider id does', async () => {
    // A query by such text would reject with Postgres 22021: answering it proves none was sent
    const user = 'usr_a\u0000b' as const;
    const plan = 'plan_a\u0000b' as const;
    const customer = 'cust_a\u0000b' as const;
    const subscription = 'sub_a\u0000b' as const;
    const payment = 'pay_a\u0000b' as const;
    const event = 'wh_a\u0000b' as const;

    expect(await repo.findActiveSubscriptionByUserId(user)).toBeNull();
    expect(await repo.findCustomerByUserId(user)).toBeNull();
    expect(await repo.findSubscriptionsByUserId(user)).toEqual([]);
    expect(await repo.findPaymentsByUserId(user)).toEqual([]);
    expect(await repo.findPlanById(plan)).toBeNull();
    expect(await repo.findCustomerById(customer)).toBeNull();
    expect(await repo.findSubscriptionById(subscription)).toBeNull();
    expect(await repo.findPaymentById(payment)).toBeNull();
    expect(await repo.findPaymentsBySubscriptionId(subscription)).toEqual([]);
    expect(await repo.findWebhookEventById(event)).toBeNull();
    expect(await repo.findSubscriptions({ limit: 20, offset: 0, userId: user })).toEqual([]);
    expect(await repo.findPayments({ limit: 20, offset: 0, customerId: customer })).toEqual([]);
    expect(await repo.updatePlan(plan, { name: 'x' })).toMatchObject({ code: 'payments.reference_not_found' });
    expect(await repo.deactivatePlan(plan)).toMatchObject({ code: 'payments.reference_not_found' });
    expect(await repo.updateCustomer(customer, { name: 'x' })).toMatchObject({ code: 'payments.reference_not_found' });
    expect(await repo.deleteCustomer(customer)).toBeUndefined();
    expect(WebhookEventNotFound.is(await repo.markWebhookEventAsProcessed(event))).toBe(true);
    expect(WebhookEventNotFound.is(await repo.updateWebhookEvent(event, { processed: true }))).toBe(true);
    expect(WebhookEventNotFound.is(await repo.incrementWebhookEventAttempts(event))).toBe(true);
  });

  it('an id or user id longer than an id column finds nothing, and a list query answers empty, not an invariant', async () => {
    // Audit 6: the id schemas now refuse such an id, so the list queries' schema check would throw on it
    const tail = 'q'.repeat(300);
    const user = `usr_${tail}` as const;
    const customer = `cust_${tail}` as const;
    const subscription = `sub_${tail}` as const;
    const plan = `plan_${tail}` as const;

    expect(await repo.findCustomerByUserId(user)).toBeNull();
    expect(await repo.findSubscriptionsByUserId(user)).toEqual([]);
    expect(await repo.findPaymentsBySubscriptionId(subscription)).toEqual([]);
    expect(await repo.findSubscriptions({ limit: 20, offset: 0, userId: user })).toEqual([]);
    expect(await repo.findSubscriptions({ limit: 20, offset: 0, planId: plan })).toEqual([]);
    expect(await repo.findPayments({ limit: 20, offset: 0, customerId: customer })).toEqual([]);
    expect(await repo.findPayments({ limit: 20, offset: 0, subscriptionId: subscription })).toEqual([]);
    expect(await repo.updatePlan(plan, { name: 'x' })).toMatchObject({ code: 'payments.reference_not_found' });
  });

  it('createCustomer refuses a user id longer than the user_id column as schema.invalid_input', async () => {
    const result = await repo.createCustomer({
      id: orThrow(createCustomerId()),
      userId: `usr_${'q'.repeat(300)}`,
      providerCustomerId: 'cus_long_user',
      email: 'long-user@example.com',
    });

    expect(result).toMatchObject({ code: 'schema.invalid_input' });
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
