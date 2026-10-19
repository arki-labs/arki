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
import { createCoreDerivedSchemas } from './derived-schemas.js';
import { toMinorColumn } from './money.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from './primitives.js';

const {
  paymentResponseSchema,
  planSelectSchema,
  planInsertSchema,
  customerSelectSchema,
  subscriptionSelectSchema,
  subscriptionInsertSchema,
  paymentSelectSchema,
  paymentInsertSchema,
  webhookEventSelectSchema,
} = createCoreDerivedSchemas(core);

const at = instant('2026-01-10T00:00:00.000Z');

function onePayment() {
  return {
    id: createPaymentId(),
    userId,
    customerId: createCustomerId(),
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
        id: createSubscriptionId(),
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
