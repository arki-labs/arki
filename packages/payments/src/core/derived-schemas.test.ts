/**
 * Response schemas derived from the tables
 *
 * `payments.list` returns each payment with its subscription. A one-off
 * payment has none, and the relational query gives `null`. The response
 * schema must accept that, or the whole list fails to validate.
 */
import { describe, expect, it } from 'vitest';

import { instant } from '@arki/date';

import { toMinorColumn } from './money.js';
import { createCustomerId, createPaymentId } from './primitives.js';
import { core, userId } from '../test-support.js';
import { createCoreDerivedSchemas } from './derived-schemas.js';
import { money } from '@arki/money';

const { paymentResponseSchema } = createCoreDerivedSchemas(core);

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
