// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * StripeProvider: amounts in Stripe's units, and refunds
 *
 * Stripe takes and sends integers in its own units, which are not always
 * cents: JPY has no minor unit, so 1500 JPY is `1500`, not `150000`. These
 * tests pin what goes over the wire and what comes back, with Stripe's HTTP
 * layer replaced by a recorder (no network).
 */
import { describe, expect, it } from 'vitest';

import { fromUnix, now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';
import { CurrencyMismatchError } from '@arki/money/errors';

import type { Payment } from '../types.js';
import type { RecordedStripeRequest } from './stripe-test-support.js';
import { createCustomerId, createPaymentId } from '../primitives.js';
import { StripeProvider } from './stripe-provider.js';
import { createFakeStripeHttp } from './stripe-test-support.js';

const CREATED = 1_767_225_600;

function paymentRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: orThrow(createPaymentId()),
    userId: 'usr_alice',
    customerId: orThrow(createCustomerId()),
    subscriptionId: null,
    providerPaymentId: 'pi_charged',
    amountMinor: 5000,
    currency: 'JPY',
    status: 'succeeded',
    paymentMethod: 'card',
    description: null,
    failureReason: null,
    receiptUrl: null,
    refunded: false,
    refundedAmountMinor: 0,
    disputeId: null,
    disputeStatus: null,
    metadata: null,
    createdAt: fromUnix(CREATED),
    updatedAt: now(),
    ...overrides,
  };
}

function provider(row: Payment, respond: (request: RecordedStripeRequest) => { status?: number; body: unknown }) {
  const http = createFakeStripeHttp(respond);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_units', webhookSecret: 'whsec_units', environment: 'sandbox' },
    {
      references: {
        findCustomerById: () => Promise.resolve(null),
        findPlanById: () => Promise.resolve(null),
        findSubscriptionById: () => Promise.resolve(null),
        findPaymentById: id => Promise.resolve(id === row.id ? row : null),
      },
      httpClient: http.client,
      maxNetworkRetries: 0,
    },
  );
  return { stripe, requests: http.requests };
}

/** Stripe's answers to a refund: the refund itself, then the payment intent with its charge. */
function refundAnswers(refund: { amount: number; status?: string }, charge: { amount: number; refunded: number }) {
  return (request: RecordedStripeRequest) =>
    request.path === '/v1/refunds'
      ? {
          body: {
            id: 're_test',
            object: 'refund',
            amount: refund.amount,
            currency: 'jpy',
            status: refund.status ?? 'succeeded',
            created: CREATED,
          },
        }
      : {
          body: {
            id: 'pi_charged',
            object: 'payment_intent',
            created: CREATED,
            amount: charge.amount,
            currency: 'jpy',
            status: 'succeeded',
            description: null,
            last_payment_error: null,
            payment_method: { id: 'pm_1', object: 'payment_method', type: 'card' },
            latest_charge: {
              id: 'ch_1',
              object: 'charge',
              amount_refunded: charge.refunded,
              receipt_url: 'https://pay.stripe.com/receipts/1',
            },
          },
        };
}

describe('refundPayment', () => {
  it('refunds the Stripe payment intent of our payment row, not the id it was given', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }, { amount: 5000, refunded: 1500 }));

    await orThrow(stripe.refundPayment(row.id, { amount: money(1500, 'JPY') }));

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/refunds',
      form: { payment_intent: 'pi_charged', 'metadata[paymentId]': row.id },
    });
  });

  it('sends a JPY refund in yen: 1500 is 1500 JPY', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }, { amount: 5000, refunded: 1500 }));

    await orThrow(stripe.refundPayment(row.id, { amount: money(1500, 'JPY') }));

    expect(requests[0]?.form.amount).toBe('1500');
  });

  it('sends a USD refund in cents: 12.34 USD is 1234', async () => {
    const row = paymentRow({ currency: 'USD' });
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1234 }, { amount: 5000, refunded: 1234 }));

    await orThrow(stripe.refundPayment(row.id, { amount: money('12.34', 'USD') }));

    expect(requests[0]?.form.amount).toBe('1234');
  });

  it('leaves the amount out for a whole refund, so Stripe refunds what was charged', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 5000 }, { amount: 5000, refunded: 5000 }));

    await orThrow(stripe.refundPayment(row.id, {}));

    expect(requests[0]?.form).not.toHaveProperty('amount');
  });

  it('answers with the Stripe refund id and our real payment, with the total refunded so far', async () => {
    const row = paymentRow({ disputeId: 'dp_1', metadata: { order: '7' } });
    // 1000 JPY were refunded before; this refund adds 1500
    const { stripe } = provider(row, refundAnswers({ amount: 1500 }, { amount: 5000, refunded: 2500 }));

    const result = await orThrow(stripe.refundPayment(row.id, { amount: money(1500, 'JPY') }));

    expect(result.providerRefundId).toBe('re_test');
    expect(result.payment).toMatchObject({
      id: row.id,
      userId: 'usr_alice',
      customerId: row.customerId,
      providerPaymentId: 'pi_charged',
      amountMinor: 5000,
      currency: 'JPY',
      status: 'succeeded',
      refunded: true,
      refundedAmountMinor: 2500,
      disputeId: 'dp_1',
      receiptUrl: 'https://pay.stripe.com/receipts/1',
      metadata: { order: '7' },
    });
  });

  it('returns ReferenceNotFound for an unknown payment id without calling Stripe: no money moves', async () => {
    const { stripe, requests } = provider(paymentRow(), refundAnswers({ amount: 1 }, { amount: 1, refunded: 0 }));

    const result = await stripe.refundPayment(orThrow(createPaymentId()), {});

    expect(result).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'payment', missing: 'row' } });
    expect(requests).toHaveLength(0);
  });

  it('refuses an amount in another currency than the payment, before calling Stripe', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1 }, { amount: 1, refunded: 0 }));

    await expect(stripe.refundPayment(row.id, { amount: money(10, 'USD') })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(requests).toHaveLength(0);
  });

  it('throws when Stripe fails the refund', async () => {
    const row = paymentRow();
    const { stripe } = provider(row, refundAnswers({ amount: 1500, status: 'failed' }, { amount: 5000, refunded: 0 }));

    await expect(stripe.refundPayment(row.id, { amount: money(1500, 'JPY') })).rejects.toMatchObject({
      code: 'unknown',
    });
  });
});

const calculation = (request: RecordedStripeRequest) => ({
  body: {
    id: 'taxcalc_1',
    object: 'tax.calculation',
    currency: request.form.currency,
    // Stripe answers in its units: 10% tax on 1500 JPY is 150 JPY
    amount_total: 1650,
    tax_amount_exclusive: 150,
    tax_amount_inclusive: 0,
    line_items: {
      object: 'list',
      data: [
        {
          tax_breakdown: [
            {
              amount: 150,
              tax_rate_details: { percentage_decimal: '10.0' },
              jurisdiction: { display_name: 'Japan', level: 'country' },
            },
          ],
        },
      ],
    },
  },
});

function taxProvider() {
  const http = createFakeStripeHttp(calculation);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_units', webhookSecret: 'whsec_units', environment: 'sandbox' },
    { httpClient: http.client, maxNetworkRetries: 0 },
  );
  return { stripe, requests: http.requests };
}

describe('calculateTax', () => {
  it('sends JPY line items in yen and reads totals back in yen', async () => {
    const { stripe, requests } = taxProvider();

    const result = await stripe.calculateTax({
      customerId: orThrow(createCustomerId()),
      currency: 'jpy',
      lineItems: [{ amount: money(1500, 'JPY'), reference: 'plan' }],
    });

    expect(requests[0]?.form['line_items[0][amount]']).toBe('1500');
    expect(result.amountTotal.toString()).toBe('1650 JPY');
    expect(result.taxAmountExclusive.toString()).toBe('150 JPY');
    expect(result.taxBreakdown[0]?.amount.toString()).toBe('150 JPY');
  });

  it('refuses a line item in another currency before calling Stripe', async () => {
    const { stripe, requests } = taxProvider();

    await expect(
      stripe.calculateTax({
        customerId: orThrow(createCustomerId()),
        currency: 'USD',
        lineItems: [{ amount: money(10, 'EUR'), reference: 'plan' }],
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
    expect(requests).toHaveLength(0);
  });
});
