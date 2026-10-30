// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.

/**
 * StripeProvider: every Stripe failure reaches the caller as a PaymentProviderError
 *
 * A caller decides what to do from `code` and `retryable`. A raw Stripe error would hide both,
 * so the methods that once let it through are pinned here.
 */
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { money, UnknownCurrency } from '@arki/money';

import type { RecordedStripeRequest } from './stripe-test-support.js';
import { createCustomerId } from '../primitives.js';
import { InvalidWebhookSignature, PaymentProviderError } from './provider-error.js';
import { StripeProvider } from './stripe-provider.js';
import { createFakeStripeHttp } from './stripe-test-support.js';

function provider(respond: (request: RecordedStripeRequest) => { status?: number; body: unknown }) {
  const http = createFakeStripeHttp(respond);
  const stripe = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    { httpClient: http.client, maxNetworkRetries: 0 },
  );
  return { stripe, requests: http.requests };
}

const invalid = () => ({
  status: 400,
  body: { error: { type: 'invalid_request_error', message: 'No such thing', code: 'resource_missing' } },
});

describe('Stripe failures', () => {
  it('createCustomer', async () => {
    const { stripe } = provider(invalid);

    await expect(stripe.createCustomer({ userId: 'usr_a', email: 'a@example.com' })).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'invalid_request',
      providerCode: 'resource_missing',
    });
  });

  it('createCheckoutSession', async () => {
    const { stripe } = provider(invalid);

    await expect(
      stripe.createCheckoutSession({
        priceId: 'price_x',
        successUrl: 'https://a.test/ok',
        cancelUrl: 'https://a.test/no',
      }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('createCheckoutSession: a session with no URL is a PaymentProviderError too', async () => {
    const { stripe } = provider(() => ({ body: { id: 'cs_1', object: 'checkout.session', url: null } }));

    await expect(
      stripe.createCheckoutSession({
        priceId: 'price_x',
        successUrl: 'https://a.test/ok',
        cancelUrl: 'https://a.test/no',
      }),
    ).rejects.toMatchObject({ name: 'PaymentProviderError', code: 'unknown' });
  });

  it('a card error from a call that charges nothing is thrown as invalid_request: the same call fails again', async () => {
    const { stripe } = provider(() => ({
      status: 402,
      body: { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } },
    }));

    await expect(stripe.createCustomer({ userId: 'usr_a', email: 'a@example.com' })).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'invalid_request',
      providerCode: 'card_declined',
    });
  });

  it('detachPaymentMethod', async () => {
    const { stripe } = provider(invalid);

    await expect(stripe.detachPaymentMethod('pm_x')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('createCustomerPortalSession', async () => {
    const { stripe } = provider(invalid);

    await expect(stripe.createCustomerPortalSession('cus_x', 'https://a.test')).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });

  it('createPlan', async () => {
    const { stripe } = provider(invalid);

    await expect(
      stripe.createPlan({ name: 'P', tier: 'pro', amount: money('1.00', 'USD'), interval: 'monthly' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('validateWebhook', () => {
  it('answers "not valid" for a bad signature, as its contract says', async () => {
    const { stripe } = provider(invalid);

    const result = await stripe.validateWebhook('{"id":"evt_1"}', 't=1,v1=bad', '1', '127.0.0.1');

    expect(result).toMatchObject({ isValid: false, provider: 'stripe' });
  });

  it('answers "not valid" for a payload that is not JSON', async () => {
    const { stripe } = provider(invalid);

    const result = await stripe.validateWebhook('not json', 't=1,v1=bad', '1', '127.0.0.1');

    expect(result.isValid).toBe(false);
  });
});

/** The `Stripe-Signature` header Stripe would send for `payload`, signed with `secret`. */
function sign(payload: string, secret: string) {
  return new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret });
}

/** A body of one event of `type` and its signature with the provider's webhook secret. */
function signed(type: string) {
  const payload = JSON.stringify({ id: 'evt_2', object: 'event', type, data: { object: { id: 'in_1' } } });
  return [payload, sign(payload, 'whsec_fake')] as const;
}

describe('constructWebhookEvent', () => {
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', data: { object: {} } });

  it('returns payments.invalid_signature for a body signed with another secret, with the Stripe error as cause', () => {
    // Anyone can POST to a webhook URL: a forged delivery is an answer for the route (HTTP 400), not a crash
    const { stripe } = provider(invalid);

    const event = stripe.constructWebhookEvent(payload, sign(payload, 'whsec_someone_else'));

    expect(InvalidWebhookSignature.is(event)).toBe(true);
    expect(InvalidWebhookSignature.is(event) && event.cause).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it('returns the typed Stripe event for a body signed with the webhook secret', () => {
    const { stripe } = provider(invalid);

    const event = stripe.constructWebhookEvent(payload, sign(payload, 'whsec_fake'));

    expect(event).toMatchObject({ id: 'evt_1', type: 'invoice.paid' });
  });
});

describe('validateWebhook event type', () => {
  it('maps a modeled Stripe event type to ours and copies the object', async () => {
    const { stripe } = provider(invalid);

    const result = await stripe.validateWebhook(...signed('invoice.payment_succeeded'), '1', '127.0.0.1');

    expect(result).toEqual({ isValid: true, provider: 'stripe', eventType: 'invoice.paid', data: { id: 'in_1' } });
  });

  it('gives no event type for one we do not model, instead of passing a Stripe name off as ours', async () => {
    const { stripe } = provider(invalid);

    const result = await stripe.validateWebhook(...signed('issuing_card.created'), '1', '127.0.0.1');

    expect(result).toMatchObject({ isValid: true, eventType: undefined });
  });
});

describe('healthCheck', () => {
  it('is healthy when Stripe answers', async () => {
    const { stripe } = provider(() => ({ body: { object: 'list', data: [], has_more: false, url: '/v1/events' } }));

    expect(await stripe.healthCheck()).toEqual({ status: 'healthy' });
  });

  it('is degraded when Stripe rate-limits, unhealthy when the key is refused', async () => {
    const limited = provider(() => ({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'Slow down' } },
    }));
    const refused = provider(() => ({
      status: 401,
      body: { error: { type: 'authentication_error', message: 'Invalid API Key' } },
    }));

    expect(await limited.stripe.healthCheck()).toEqual({ status: 'degraded', details: 'Slow down' });
    expect(await refused.stripe.healthCheck()).toEqual({ status: 'unhealthy', details: 'Invalid API Key' });
  });
});

describe('calculateTax', () => {
  it('returns the money failure when Stripe answers an amount in a currency money does not know', async () => {
    const { stripe } = provider(() => ({
      body: {
        id: 'taxcalc_1',
        object: 'tax.calculation',
        currency: 'zzz',
        amount_total: 1190,
        tax_amount_exclusive: 190,
        tax_amount_inclusive: 0,
        line_items: { object: 'list', data: [] },
      },
    }));

    const result = await stripe.calculateTax({
      customerId: orThrow(createCustomerId()),
      currency: 'eur',
      lineItems: [{ amount: money('10.00', 'EUR'), reference: 'plan' }],
    });

    expect(UnknownCurrency.is(result)).toBe(true);
  });

  it('reports the tax code of the line item, not the level of the jurisdiction', async () => {
    const { stripe } = provider(request => ({
      body: {
        id: 'taxcalc_1',
        object: 'tax.calculation',
        currency: request.form['currency'],
        amount_total: 1190,
        tax_amount_exclusive: 190,
        tax_amount_inclusive: 0,
        line_items: {
          object: 'list',
          data: [
            {
              tax_code: 'txcd_10103001',
              tax_breakdown: [
                {
                  amount: 190,
                  tax_rate_details: { percentage_decimal: '19.0' },
                  jurisdiction: { display_name: 'Germany', level: 'country', country: 'DE', state: null },
                },
              ],
            },
          ],
        },
      },
    }));

    const result = orThrow(await stripe.calculateTax({
      customerId: orThrow(createCustomerId()),
      currency: 'eur',
      lineItems: [{ amount: money('10.00', 'EUR'), reference: 'plan' }],
    }));

    expect(result.taxBreakdown[0]).toMatchObject({ jurisdiction: 'Germany', rate: 19, taxCode: 'txcd_10103001' });
  });
});

describe('ID failures before Stripe effects', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the canonical failure before creating customers or products', async () => {
    const { stripe, requests } = provider(() => ({ body: {} }));
    vi.stubGlobal('crypto', {});

    expect(RandomSourceUnavailable.is(await stripe.createCustomer({ userId: 'usr_a', email: 'a@example.com' }))).toBe(
      true,
    );
    expect(
      RandomSourceUnavailable.is(
        await stripe.createPlan({
          name: 'Pro',
          tier: 'pro',
          amount: money('9.99', 'USD'),
          interval: 'monthly',
        }),
      ),
    ).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
