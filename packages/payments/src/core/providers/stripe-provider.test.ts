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
import { IdempotencyConflict } from './provider-error.js';
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

/** A Stripe refund as the API sends it. */
function stripeRefund(
  id: string,
  overrides: { amount?: number; status?: string; refundId?: string; failureReason?: string } = {},
) {
  return {
    id,
    object: 'refund',
    amount: overrides.amount ?? 1500,
    currency: 'jpy',
    status: overrides.status ?? 'succeeded',
    created: CREATED,
    metadata: overrides.refundId === undefined ? {} : { refundId: overrides.refundId },
    ...(overrides.failureReason === undefined ? {} : { failure_reason: overrides.failureReason }),
  };
}

/** Stripe's answer to a refund create: the refund, with `status` as given. */
function refundAnswers(refund: { amount: number; status?: string; failureReason?: string }) {
  return () => ({ body: stripeRefund('re_test', refund) });
}

/**
 * Stripe's refunds endpoint with its idempotency: a create with a key Stripe has seen gets the first
 * refund back, and creates nothing. A create without a key always makes a new refund.
 */
function stripeWithIdempotency() {
  const refundsByKey = new Map<string, ReturnType<typeof stripeRefund>>();
  let created = 0;
  const respond = (request: RecordedStripeRequest) => {
    const key = request.headers['idempotency-key'];
    const seen = key === undefined ? undefined : refundsByKey.get(key);
    if (seen) return { body: seen };
    created += 1;
    const refund = stripeRefund(`re_${created}`);
    if (key !== undefined) refundsByKey.set(key, refund);
    return { body: refund };
  };
  return { respond, created: () => created };
}

describe('refundPayment', () => {
  it('refunds the Stripe payment intent of our payment row, not the id it was given', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }));

    await orThrow(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1', amount: money(1500, 'JPY') }),
    );

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/refunds',
      form: { payment_intent: 'pi_charged', 'metadata[paymentId]': row.id },
    });
  });

  it('refundPayment sends the key so a re-run creates one Stripe refund', async () => {
    const row = paymentRow();
    const fakeStripe = stripeWithIdempotency();
    const { stripe, requests } = provider(row, fakeStripe.respond);
    const params = { refundId: 'rfnd_1', idempotencyKey: 'rfnd_1', amount: money(1500, 'JPY') } as const;

    const first = await orThrow(stripe.refundPayment(row.id, params));
    // The run crashed after Stripe answered: the retry sends the same request with the same key
    const rerun = await orThrow(stripe.refundPayment(row.id, params));

    expect(rerun.providerRefundId).toBe(first.providerRefundId);
    expect(fakeStripe.created()).toBe(1);
    expect(requests.map(request => request.headers['idempotency-key'])).toEqual(['rfnd_1', 'rfnd_1']);
  });

  it('sends a JPY refund in yen: 1500 is 1500 JPY', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }));

    await orThrow(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1', amount: money(1500, 'JPY') }),
    );

    expect(requests[0]?.form.amount).toBe('1500');
  });

  it('sends a USD refund in cents: 12.34 USD is 1234', async () => {
    const row = paymentRow({ currency: 'USD' });
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1234 }));

    await orThrow(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1', amount: money('12.34', 'USD') }),
    );

    expect(requests[0]?.form.amount).toBe('1234');
  });

  it('leaves the amount out for a whole refund, so Stripe refunds what was charged', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 5000 }));

    await orThrow(stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1' }));

    expect(requests[0]?.form).not.toHaveProperty('amount');
  });

  it('answers with the Stripe refund id and status from the one create call, with no second read', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }));

    const result = await orThrow(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1', amount: money(1500, 'JPY') }),
    );

    expect(result).toEqual({ providerRefundId: 're_test', status: 'succeeded', failureReason: null });
    expect(requests).toHaveLength(1);
  });

  /** The workflow decides what a failed refund means; a throw would make it retry a refund Stripe already settled. */
  it('a failed or canceled Stripe refund comes back as data, not a throw', async () => {
    const row = paymentRow();
    for (const status of ['failed', 'canceled', 'pending', 'requires_action']) {
      const { stripe } = provider(row, refundAnswers({ amount: 1500, status }));

      const result = await stripe.refundPayment(row.id, {
        refundId: 'rfnd_1',
        idempotencyKey: `refund-${status}`,
        amount: money(1500, 'JPY'),
      });

      expect(result).toEqual({ providerRefundId: 're_test', status, failureReason: null });
    }
  });

  /** The workflow records why Stripe gave up, so support can tell the customer what to do next. */
  it('a failed Stripe refund carries its failureReason', async () => {
    const row = paymentRow();
    const { stripe } = provider(
      row,
      refundAnswers({ amount: 1500, status: 'failed', failureReason: 'insufficient_funds' }),
    );

    const result = await stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'rfnd_1' });

    expect(result).toEqual({ providerRefundId: 're_test', status: 'failed', failureReason: 'insufficient_funds' });
  });

  /** `findRefund` is the only guard once the key has expired; a caller's stray `refundId` must not break it. */
  it('refundPayment sets metadata.refundId so findRefund can always match it', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1500 }));

    await orThrow(
      stripe.refundPayment(row.id, {
        refundId: 'rfnd_ours',
        idempotencyKey: 'key-1',
        metadata: { refundId: 'rfnd_caller', note: 'kept' },
      }),
    );

    expect(requests[0]?.form).toMatchObject({ 'metadata[refundId]': 'rfnd_ours', 'metadata[note]': 'kept' });
  });

  /** A conflict is a bug in the caller, not a passing outage: the workflow must stop, not retry it. */
  it('a reused key with different parameters is reported as an idempotency conflict', async () => {
    const row = paymentRow();
    const { stripe } = provider(row, () => ({
      status: 400,
      body: {
        error: {
          type: 'idempotency_error',
          message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.',
        },
      },
    }));

    const result = await stripe.refundPayment(row.id, {
      refundId: 'rfnd_1',
      idempotencyKey: 'refund-1',
      amount: money(900, 'JPY'),
    });

    expect(IdempotencyConflict.is(result)).toBe(true);
  });

  it('throws a retryable error when Stripe is down, so the same key can be sent again', async () => {
    const row = paymentRow();
    const { stripe } = provider(row, () => ({ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }));

    await expect(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1' }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });

  it('returns ReferenceNotFound for an unknown payment id without calling Stripe: no money moves', async () => {
    const { stripe, requests } = provider(paymentRow(), refundAnswers({ amount: 1 }));

    const result = await stripe.refundPayment(orThrow(createPaymentId()), {
      refundId: 'rfnd_1',
      idempotencyKey: 'refund-1',
    });

    expect(result).toMatchObject({ code: 'payments.reference_not_found', data: { kind: 'payment', missing: 'row' } });
    expect(requests).toHaveLength(0);
  });

  it('refuses an amount in another currency than the payment, before calling Stripe', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, refundAnswers({ amount: 1 }));

    await expect(
      stripe.refundPayment(row.id, { refundId: 'rfnd_1', idempotencyKey: 'refund-1', amount: money(10, 'USD') }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
});

/** A page of Stripe's refund list. */
const refundPage = (data: unknown[], hasMore: boolean) => ({
  body: { object: 'list', url: '/v1/refunds', has_more: hasMore, data },
});

/** Stripe's refund list for the payment intent: two pages, with the refund we look for on the second. */
function twoPages(request: RecordedStripeRequest) {
  return request.form.starting_after === undefined
    ? refundPage([stripeRefund('re_other', { refundId: 'rfnd_other' }), stripeRefund('re_bare')], true)
    : refundPage([stripeRefund('re_ours', { refundId: 'rfnd_ours', status: 'pending' })], false);
}

describe('findRefund', () => {
  it('findRefund matches metadata.refundId so an expired key never refunds twice', async () => {
    const row = paymentRow();
    const { stripe, requests } = provider(row, twoPages);

    const found = await orThrow(stripe.findRefund(row.id, 'rfnd_ours'));

    expect(found).toEqual({ providerRefundId: 're_ours', status: 'pending', failureReason: null });
    // Every page of the payment intent's refunds is read until the match
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/refunds', form: { payment_intent: 'pi_charged' } });
    expect(requests[1]?.form.starting_after).toBe('re_bare');
  });

  it('answers null when no refund of the payment carries our refund id, so the caller creates it', async () => {
    const row = paymentRow();
    const { stripe } = provider(row, twoPages);

    expect(await orThrow(stripe.findRefund(row.id, 'rfnd_never_made'))).toBeNull();
  });

  it('returns ReferenceNotFound for an unknown payment id without calling Stripe', async () => {
    const { stripe, requests } = provider(paymentRow(), twoPages);

    const result = await stripe.findRefund(orThrow(createPaymentId()), 'rfnd_ours');

    expect(result).toMatchObject({ code: 'payments.reference_not_found' });
    expect(requests).toHaveLength(0);
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
