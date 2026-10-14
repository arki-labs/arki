/**
 * TaxService.calculateTax: a failure is never zero tax
 *
 * A checkout that charged without tax because Stripe Tax was down would
 * under-collect on every sale until someone noticed. The service lets the
 * provider's error through, so the caller decides whether to retry or stop.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@arki/money';

import { createCustomerId } from '../core/primitives.js';
import { PaymentProviderError } from '../core/providers/provider-error.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { TaxService } from './service.js';

/** No exemptions: nothing in these tests is exempt. */
const noExemptions = {
  exemptions: { findApplicableExemptions: () => Promise.resolve([]) },
  jurisdictions: { findJurisdictionById: () => Promise.resolve(null) },
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
  customerId: createCustomerId(),
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

    const result = await tax.calculateTax(input);

    expect(requests[0]).toMatchObject({ path: '/v1/tax/calculations', form: { currency: 'usd' } });
    expect(result.taxAmount.toDecimalString()).toBe('19.00');
    expect(result.total.toDecimalString()).toBe('119.00');
    expect(result.subtotal.toDecimalString()).toBe('100.00');
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
