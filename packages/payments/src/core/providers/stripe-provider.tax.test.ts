// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * StripeProvider: tax transactions and tax settings against a fake HTTP layer
 *
 * A recorded sale must come from a real Stripe tax calculation, and the totals must be the ones Stripe
 * recorded, never zero or a guess. Settings errors must reach the caller.
 */
import { describe, expect, it } from 'vitest';

import { now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { Customer } from '../types.js';
import type { RecordedStripeRequest } from './stripe-test-support.js';
import { createCustomerId } from '../primitives.js';
import { StripeProvider } from './stripe-provider.js';
import { createFakeStripeHttp } from './stripe-test-support.js';

const customer: Customer = {
  id: orThrow(createCustomerId()),
  userId: 'usr_alice',
  providerCustomerId: 'cus_alice',
  provider: 'stripe',
  email: 'alice@example.com',
  name: null,
  defaultPaymentMethodId: null,
  metadata: null,
  createdAt: now(),
  updatedAt: now(),
};

function provider(respond: (request: RecordedStripeRequest) => { status?: number; body: unknown }) {
  const http = createFakeStripeHttp(respond);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    {
      references: {
        findCustomerById: id => Promise.resolve(id === customer.id ? customer : null),
        findPlanById: () => Promise.resolve(null),
        findSubscriptionById: () => Promise.resolve(null),
        findPaymentById: () => Promise.resolve(null),
      },
      httpClient: http.client,
      maxNetworkRetries: 0,
    },
  );
  return { stripe, requests: http.requests };
}

const list = (data: unknown[]) => ({ object: 'list', url: '/v1/x', has_more: false, data });

/** A Stripe tax transaction with the given line items (amounts in Stripe's units). */
function transaction(
  id: string,
  currency: string,
  lines: { amount: number; amount_tax: number; tax_behavior: 'exclusive' | 'inclusive' }[],
) {
  return { id, object: 'tax.transaction', currency, line_items: list(lines) };
}

describe('createTaxTransaction', () => {
  it('records a sale: calculates the tax, then records that calculation, and returns the recorded totals', async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/tax/calculations'
        ? { body: { id: 'taxcalc_1', object: 'tax.calculation', currency: 'usd' } }
        : {
            // 20% tax on top of 2 x 10.00 USD
            body: transaction('tax_txn_1', 'usd', [{ amount: 2000, amount_tax: 400, tax_behavior: 'exclusive' }]),
          },
    );

    const result = await orThrow(
      stripe.createTaxTransaction({
        reference: 'order_7',
        type: 'sale',
        customerId: customer.id,
        currency: 'USD',
        lineItems: [{ amount: money('10.00', 'USD'), quantity: 2, reference: 'plan' }],
        customerDetails: { address: { country: 'DE', postalCode: '10115' } },
      }),
    );

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/tax/calculations',
      form: {
        currency: 'usd',
        customer: 'cus_alice',
        'line_items[0][amount]': '2000',
        'line_items[0][quantity]': '2',
        'customer_details[address][country]': 'DE',
        'customer_details[address][postal_code]': '10115',
      },
    });
    expect(requests[1]).toMatchObject({
      method: 'POST',
      path: '/v1/tax/transactions/create_from_calculation',
      form: { calculation: 'taxcalc_1', reference: 'order_7' },
    });
    expect(result.id).toBe('tax_txn_1');
    expect(result.amountTotal.toString()).toBe('24.00 USD');
    expect(result.taxAmountExclusive.toString()).toBe('4.00 USD');
    expect(result.taxAmountInclusive.toString()).toBe('0.00 USD');
  });

  it('keeps inclusive tax inside the total: it is already in the line amount', async () => {
    const { stripe } = provider(request =>
      request.path === '/v1/tax/calculations'
        ? { body: { id: 'taxcalc_1', object: 'tax.calculation', currency: 'eur' } }
        : { body: transaction('tax_txn_2', 'eur', [{ amount: 1200, amount_tax: 200, tax_behavior: 'inclusive' }]) },
    );

    const result = await orThrow(
      stripe.createTaxTransaction({
        reference: 'order_8',
        type: 'sale',
        currency: 'EUR',
        lineItems: [{ amount: money('12.00', 'EUR'), reference: 'plan' }],
      }),
    );

    expect(result.amountTotal.toString()).toBe('12.00 EUR');
    expect(result.taxAmountInclusive.toString()).toBe('2.00 EUR');
    expect(result.taxAmountExclusive.toString()).toBe('0.00 EUR');
  });

  it('reverses the whole original transaction for a refund with no line items', async () => {
    const { stripe, requests } = provider(() => ({
      body: transaction('tax_txn_r', 'usd', [{ amount: -2000, amount_tax: -400, tax_behavior: 'exclusive' }]),
    }));

    const result = await orThrow(
      stripe.createTaxTransaction({
        reference: 'refund_7',
        type: 'refund',
        currency: 'USD',
        originalTransactionId: 'tax_txn_1',
        lineItems: [],
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/tax/transactions/create_reversal',
      form: { mode: 'full', original_transaction: 'tax_txn_1', reference: 'refund_7' },
    });
    expect(result.amountTotal.toString()).toBe('-24.00 USD');
    expect(result.taxAmountExclusive.toString()).toBe('-4.00 USD');
  });

  it('reverses a refunded total with a negative flat amount for a partial refund', async () => {
    const { stripe, requests } = provider(() => ({
      body: transaction('tax_txn_r', 'usd', [{ amount: -500, amount_tax: -100, tax_behavior: 'exclusive' }]),
    }));

    await orThrow(
      stripe.createTaxTransaction({
        reference: 'refund_7',
        type: 'refund',
        currency: 'USD',
        originalTransactionId: 'tax_txn_1',
        lineItems: [{ amount: money('6.00', 'USD'), reference: 'plan' }],
      }),
    );

    expect(requests[0]?.form).toMatchObject({ mode: 'partial', flat_amount: '-600' });
  });

  it('refuses a refund that does not say which sale it reverses, before calling Stripe', async () => {
    const { stripe, requests } = provider(() => ({ body: {} }));

    await expect(
      stripe.createTaxTransaction({ reference: 'r', type: 'refund', currency: 'USD', lineItems: [] }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('shows a Stripe failure as PaymentProviderError instead of a made-up result', async () => {
    const { stripe } = provider(() => ({
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'Tax is not set up' } },
    }));

    await expect(
      stripe.createTaxTransaction({
        reference: 'order_9',
        type: 'sale',
        currency: 'USD',
        lineItems: [{ amount: money('1.00', 'USD'), reference: 'plan' }],
      }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', code: 'invalid_request' });
  });
});

describe('getTaxSettings', () => {
  it('reads the settings and the registrations from Stripe', async () => {
    const { stripe, requests } = provider(request =>
      request.path === '/v1/tax/settings'
        ? {
            body: {
              object: 'tax.settings',
              defaults: { tax_code: 'txcd_20030000' },
              head_office: {
                address: { country: 'DE', city: 'Berlin', postal_code: '10115', line1: null, state: null },
              },
            },
          }
        : {
            body: list([
              {
                id: 'taxreg_1',
                object: 'tax.registration',
                country: 'DE',
                status: 'active',
                country_options: { de: { type: 'standard' } },
              },
              {
                id: 'taxreg_2',
                object: 'tax.registration',
                country: 'FR',
                status: 'scheduled',
                country_options: { fr: { type: 'simplified' } },
              },
            ]),
          },
    );

    const settings = await stripe.getTaxSettings();

    // `head_office` and `status_details` are inline in the settings object: Stripe has nothing to expand
    // there, and asking for it is an error. The head office above came back without any expand.
    expect(requests[0]).toMatchObject({ path: '/v1/tax/settings' });
    expect(Object.keys(requests[0]?.form ?? {}).filter(key => key.startsWith('expand'))).toEqual([]);
    expect(requests[1]).toMatchObject({ path: '/v1/tax/registrations', form: { status: 'all' } });
    expect(settings).toEqual({
      defaultTaxCode: 'txcd_20030000',
      headOfficeLocation: { address: { country: 'DE', city: 'Berlin', postalCode: '10115' } },
      taxRegistrations: [
        { country: 'DE', type: 'standard', status: 'active' },
        { country: 'FR', type: 'simplified', status: 'scheduled' },
      ],
    });
  });

  it('says there is no head office when Stripe has none, instead of inventing a country', async () => {
    const { stripe } = provider(request =>
      request.path === '/v1/tax/settings'
        ? { body: { object: 'tax.settings', defaults: { tax_code: null }, head_office: null } }
        : { body: list([]) },
    );

    const settings = await stripe.getTaxSettings();

    expect(settings.headOfficeLocation).toBeUndefined();
    expect(settings.taxRegistrations).toEqual([]);
  });

  it('throws PaymentProviderError when Stripe fails, so the caller can tell', async () => {
    const { stripe } = provider(() => ({
      status: 401,
      body: { error: { type: 'authentication_error', message: 'Invalid API Key' } },
    }));

    await expect(stripe.getTaxSettings()).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'authentication',
    });
  });
});

describe('tax reports', () => {
  it('does not claim a Stripe report: Stripe Tax has no report endpoint', () => {
    const { stripe } = provider(() => ({ body: {} }));

    expect(stripe.features.taxReporting).toBe(false);
    expect('getTaxReport' in stripe).toBe(false);
  });
});
