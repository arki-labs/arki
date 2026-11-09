// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
import { orThrow } from '@arki/failure';

/**
 * Response schemas derived from the tables
 *
 * `payments.list` returns each payment with its subscription. A one-off
 * payment has none, and the relational query gives `null`. The response
 * schema must accept that, or the whole list fails to validate.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { z } from '@arki/contracts';
import { instant } from '@arki/date';
import { money } from '@arki/money';

import { core, userId } from '../test-support.js';
import type {
  billingIntervalSchema,
  paymentMethodTypeSchema,
  paymentStatusSchema,
  planTierSchema,
  subscriptionStatusSchema,
} from './contracts.js';
import { createPlanInputSchema } from './contracts.js';
import { createCoreDerivedSchemas } from './derived-schemas.js';
import { toMinorColumn } from './money.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from './primitives.js';

const {
  paymentResponseSchema,
  planSelectSchema,
  planInsertSchema,
  planUpdateSchema,
  customerSelectSchema,
  customerInsertSchema,
  subscriptionSelectSchema,
  subscriptionInsertSchema,
  paymentSelectSchema,
  paymentInsertSchema,
  webhookEventSelectSchema,
  webhookEventInsertSchema,
} = createCoreDerivedSchemas(core);

const at = instant('2026-01-10T00:00:00.000Z');

function onePayment() {
  return {
    id: orThrow(createPaymentId()),
    userId,
    customerId: orThrow(createCustomerId()),
    subscriptionId: null,
    providerPaymentId: 'pi_one_off',
    amountMinor: toMinorColumn(money(25, 'USD')),
    currency: 'USD',
    status: 'succeeded' as const,
    paymentMethod: 'card' as const,
    description: null,
    failureReason: null,
    receiptUrl: null,
    refunded: false,
    refundedAmountMinor: 0,
    disputeId: null,
    disputeStatus: null,
    metadata: null,
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

describe('paymentResponseSchema', () => {
  it('accepts a one-off payment whose subscription is null', () => {
    const result = paymentResponseSchema.safeParse({ ...onePayment(), subscription: null });

    expect(result.success).toBe(true);
  });

  it('accepts a payment with no subscription key at all', () => {
    expect(paymentResponseSchema.safeParse(onePayment()).success).toBe(true);
  });
});

describe('canonical table validators', () => {
  it('keeps canonical enum inputs and outputs through select and insert schemas', () => {
    expectTypeOf<z.input<typeof planSelectSchema.shape.interval>>().toEqualTypeOf<
      z.input<typeof billingIntervalSchema>
    >();
    expectTypeOf<z.output<typeof planSelectSchema.shape.interval>>().toEqualTypeOf<
      z.output<typeof billingIntervalSchema>
    >();
    expectTypeOf<z.input<typeof planInsertSchema.shape.interval>>().toEqualTypeOf<
      z.input<typeof billingIntervalSchema> | undefined
    >();
    expectTypeOf<z.input<typeof planSelectSchema.shape.tier>>().toEqualTypeOf<z.input<typeof planTierSchema>>();
    expectTypeOf<z.output<typeof planSelectSchema.shape.tier>>().toEqualTypeOf<z.output<typeof planTierSchema>>();
    expectTypeOf<z.input<typeof planInsertSchema.shape.tier>>().toEqualTypeOf<
      z.input<typeof planTierSchema> | undefined
    >();
    expectTypeOf<z.input<typeof subscriptionSelectSchema.shape.status>>().toEqualTypeOf<
      z.input<typeof subscriptionStatusSchema>
    >();
    expectTypeOf<z.output<typeof subscriptionSelectSchema.shape.status>>().toEqualTypeOf<
      z.output<typeof subscriptionStatusSchema>
    >();
    expectTypeOf<z.input<typeof subscriptionInsertSchema.shape.status>>().toEqualTypeOf<
      z.input<typeof subscriptionStatusSchema> | undefined
    >();
    expectTypeOf<z.input<typeof paymentSelectSchema.shape.status>>().toEqualTypeOf<
      z.input<typeof paymentStatusSchema>
    >();
    expectTypeOf<z.output<typeof paymentSelectSchema.shape.status>>().toEqualTypeOf<
      z.output<typeof paymentStatusSchema>
    >();
    expectTypeOf<z.input<typeof paymentInsertSchema.shape.status>>().toEqualTypeOf<
      z.input<typeof paymentStatusSchema> | undefined
    >();
    expectTypeOf<z.input<typeof paymentSelectSchema.shape.paymentMethod>>().toEqualTypeOf<
      z.input<typeof paymentMethodTypeSchema>
    >();
    expectTypeOf<z.output<typeof paymentSelectSchema.shape.paymentMethod>>().toEqualTypeOf<
      z.output<typeof paymentMethodTypeSchema>
    >();
    expectTypeOf<z.input<typeof paymentInsertSchema.shape.paymentMethod>>().toEqualTypeOf<
      z.input<typeof paymentMethodTypeSchema> | undefined
    >();
  });

  it('rejects unknown enum values while preserving insert defaults', () => {
    for (const schema of [
      planSelectSchema.shape.interval,
      planSelectSchema.shape.tier,
      subscriptionSelectSchema.shape.status,
      paymentSelectSchema.shape.status,
      paymentSelectSchema.shape.paymentMethod,
    ]) {
      expect(schema.safeParse('invalid-enum').success).toBe(false);
    }
    expect(planInsertSchema.pick({ interval: true, tier: true }).parse({})).toEqual({});
    expect(subscriptionInsertSchema.pick({ status: true }).parse({})).toEqual({});
    expect(paymentInsertSchema.pick({ status: true, paymentMethod: true }).parse({})).toEqual({});
  });

  it('parses timestamps into the Temporal values that payment callers use', () => {
    const parsed = subscriptionSelectSchema
      .pick({
        id: true,
        createdAt: true,
        currentPeriodStart: true,
        trialStart: true,
      })
      .parse({
        id: orThrow(createSubscriptionId()),
        createdAt: at.toString(),
        currentPeriodStart: new Date(at.epochMilliseconds),
        trialStart: null,
      });

    expectTypeOf(parsed.id).toEqualTypeOf<typeof core.subscriptions.$inferSelect.id>();
    expectTypeOf(parsed.createdAt).toEqualTypeOf<typeof core.subscriptions.$inferSelect.createdAt>();
    expectTypeOf(parsed.currentPeriodStart).toEqualTypeOf<typeof core.subscriptions.$inferSelect.currentPeriodStart>();
    expectTypeOf(parsed.trialStart).toEqualTypeOf<typeof core.subscriptions.$inferSelect.trialStart>();
    expect(parsed.createdAt.equals(at)).toBe(true);
    expect(parsed.currentPeriodStart.equals(at)).toBe(true);
    expect(parsed.trialStart).toBeNull();
  });

  it('rejects invalid timestamps and IDs instead of trusting column annotations', () => {
    for (const schema of [planSelectSchema, customerSelectSchema, subscriptionSelectSchema, webhookEventSelectSchema]) {
      expect(schema.shape.createdAt.safeParse('not-a-timestamp').success).toBe(false);
      expect(schema.shape.id.safeParse('wrong_id').success).toBe(false);
    }
    expect(planSelectSchema.shape.features.safeParse([1]).success).toBe(false);
    expect(paymentResponseSchema.shape.subscriptionId.safeParse('wrong_id').success).toBe(false);
  });

  it('preserves optional generated fields and nullable foreign keys on inserts', () => {
    const parsed = paymentInsertSchema.pick({ id: true, createdAt: true, subscriptionId: true }).parse({
      subscriptionId: null,
    });
    expect(parsed).toEqual({ subscriptionId: null });
    expect(webhookEventSelectSchema.shape.processedAt.parse(null)).toBeNull();
    expect(webhookEventSelectSchema.shape.lastAttemptAt.parse(at.toString())?.equals(at)).toBe(true);
  });
});

describe('insert schemas refuse what the columns refuse', () => {
  const planBase = { name: 'Pro', priceMinor: 1000 };

  it.each([
    ['U+0000 in the plan name', planInsertSchema, { ...planBase, name: 'P\u0000ro' }],
    ['U+0000 in a plan feature', planInsertSchema, { ...planBase, features: ['a\u0000'] }],
    ['a lone surrogate in a plan feature (jsonb refuses it, 22P02)', planInsertSchema, { ...planBase, features: ['a\uD800'] }],
    ['a lone surrogate in webhook data (jsonb refuses it, 22P02)', webhookEventInsertSchema, { provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_1', data: { a: '\uDC00' } }],
    ['a fractional interval count', planInsertSchema, { ...planBase, intervalCount: 1.5 }],
    ['fractional trial days', planInsertSchema, { ...planBase, trialPeriodDays: 1.5 }],
    ['a currency outside ISO 4217', planInsertSchema, { ...planBase, currency: 'ZZZ' }],
    ['U+0000 in the customer name', customerInsertSchema, { userId, providerCustomerId: 'cus_1', email: 'a@example.com', name: 'N\u0000' }],
    ['webhook attempts past the integer range', webhookEventInsertSchema, { provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_1', data: {}, attempts: 2_147_483_648 }],
    ['U+0000 in webhook data', webhookEventInsertSchema, { provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_1', data: { a: '\u0000' } }],
    ['U+0000 in a plan id', planInsertSchema, { ...planBase, id: 'plan_a\u0000b' }],
    ['U+0000 in a customer id', customerInsertSchema, { id: 'cust_a\u0000b', userId, providerCustomerId: 'cus_1', email: 'a@example.com' }],
    ['U+0000 in a webhook id', webhookEventInsertSchema, { id: 'wh_a\u0000b', provider: 'stripe', eventType: 'customer.created', providerEventId: 'evt_1', data: {} }],
  ] as const)('%s', (_what, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('the plan input contract refuses a lone surrogate in a feature and keeps an emoji', () => {
    const plan = { name: 'Pro', tier: 'pro', price: { amount: '10', currency: 'EUR' }, interval: 'monthly' } as const;

    expect(createPlanInputSchema.safeParse({ ...plan, features: ['ok', 'a\uD800'] }).success).toBe(false);
    expect(createPlanInputSchema.safeParse({ ...plan, features: ['\uD83D\uDE00'] }).success).toBe(true);
  });

  it('a free plan costs zero, and the update schema leaves out what the caller did not send', () => {
    expect(planInsertSchema.safeParse({ ...planBase, priceMinor: 0 }).success).toBe(true);
    // The id refinement refuses only what a column cannot hold
    expect(planInsertSchema.safeParse({ ...planBase, id: 'plan_ab' }).success).toBe(true);
    // A `.default` here would reset the stored features on every update
    expect(planUpdateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });
});
