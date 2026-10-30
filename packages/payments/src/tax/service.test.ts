// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.

/**
 * TaxService.calculateTax: a failure is never zero tax
 *
 * A checkout that charged without tax because Stripe Tax was down would
 * under-collect on every sale until someone noticed. The service lets the
 * provider's error through, so the caller decides whether to retry or stop.
 */
import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { money, UnknownCurrency } from '@arki/money';

import { createCustomerId } from '../core/primitives.js';
import { PaymentProviderError, TaxAddressIncomplete } from '../core/providers/provider-error.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { TaxService } from './service.js';

/** No exemptions: nothing in these tests is exempt. */
const noExemptions = {
  exemptions: { findApplicableExemptions: () => Promise.resolve([]) },
  jurisdictions: { findJurisdictionById: () => Promise.resolve(null) },
  records: {
    findByReference: () => Promise.resolve([]),
    recordMany: () => Promise.resolve(),
    totalsByJurisdiction: () => Promise.resolve([]),
    countSaleTransactions: () => Promise.resolve(0),
  },
};

function serviceAnswering(status: number, body: unknown) {
  const http = createFakeStripeHttp(() => ({ status, body }));
  const provider = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    { httpClient: http.client, maxNetworkRetries: 0 },
  );

  return { tax: new TaxService(provider, noExemptions), requests: http.requests };
}

const input = {
  customerId: orThrow(createCustomerId()),
  currency: 'USD',
  lineItems: [{ amount: money('100', 'USD'), description: 'Pro', reference: 'line_1' }],
};

describe('calculateTax', () => {
  it('returns the tax Stripe calculated', async () => {
    const { tax, requests } = serviceAnswering(200, {
      object: 'tax.calculation',
      currency: 'usd',
      amount_total: 11_900,
      tax_amount_exclusive: 1900,
      tax_amount_inclusive: 0,
      line_items: { data: [] },
    });

    const result = orThrow(await tax.calculateTax(input));

    expect(requests[0]).toMatchObject({ path: '/v1/tax/calculations', form: { currency: 'usd' } });
    expect(result.taxAmount.toDecimalString()).toBe('19.00');
    expect(result.total.toDecimalString()).toBe('119.00');
    expect(result.subtotal.toDecimalString()).toBe('100.00');
  });

  it('returns the money failure when Stripe answers an amount in an unknown currency, never a tax figure', async () => {
    const { tax } = serviceAnswering(200, {
      object: 'tax.calculation',
      currency: 'zzz',
      amount_total: 11_900,
      tax_amount_exclusive: 1900,
      tax_amount_inclusive: 0,
      line_items: { data: [] },
    });

    expect(UnknownCurrency.is(await tax.calculateTax(input))).toBe(true);
  });

  it('returns TaxAddressIncomplete for an address with no country, and asks Stripe nothing', async () => {
    const { tax, requests } = serviceAnswering(200, {});

    const refused = await tax.calculateTax({ ...input, customerDetails: { address: { postalCode: '10115' } } });

    expect(TaxAddressIncomplete.is(refused)).toBe(true);
    expect(requests).toEqual([]);
  });

  it('rejects when Stripe Tax is down, so a sale is not priced with zero tax', async () => {
    const { tax } = serviceAnswering(500, { error: { type: 'api_error', message: 'Stripe Tax is down' } });

    const failure = await tax.calculateTax(input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PaymentProviderError);
    expect(failure).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('rejects when Stripe refuses the request, and says it will not work on retry', async () => {
    const { tax } = serviceAnswering(400, {
      error: { type: 'invalid_request_error', message: 'Invalid tax code', param: 'line_items' },
    });

    await expect(tax.calculateTax(input)).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
  });
});

describe('calculateSubscriptionTax and calculateOneTimeTax', () => {
  // Both only build a one-line calculation: the checkout must still see the refusal, never a tax figure
  const noCountry = { address: { postalCode: '10115' } };

  it('calculateSubscriptionTax returns TaxAddressIncomplete for an address with no country, and asks Stripe nothing', async () => {
    const { tax, requests } = serviceAnswering(200, {});

    const refused = await tax.calculateSubscriptionTax({
      customerId: input.customerId,
      planAmount: money('29.99', 'USD'),
      planInterval: 'monthly',
      customerDetails: noCountry,
    });

    expect(TaxAddressIncomplete.is(refused)).toBe(true);
    expect(requests).toEqual([]);
  });

  it('calculateOneTimeTax returns TaxAddressIncomplete for an address with no country, and asks Stripe nothing', async () => {
    const { tax, requests } = serviceAnswering(200, {});

    const refused = await tax.calculateOneTimeTax({
      customerId: input.customerId,
      amount: money('5', 'USD'),
      description: 'Tip',
      customerDetails: noCountry,
    });

    expect(TaxAddressIncomplete.is(refused)).toBe(true);
    expect(requests).toEqual([]);
  });
});
