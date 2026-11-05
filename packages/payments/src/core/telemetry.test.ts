// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * Every Stripe request runs in a `payments.<operation>` span
 *
 * An operator finds a slow or failing provider call by its span. A declined card is an answer, not
 * an error: its span ends OK with the failure code, so alerts on span errors fire only for faults.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SpanCapture } from '@arki/testing/otel';
import { now } from '@arki/date';
import { defineFailure, orThrow } from '@arki/failure';
import { money } from '@arki/money';
import { captureSpans } from '@arki/testing/otel';

import type { RecordedStripeRequest } from './providers/stripe-test-support.js';
import type { Customer } from './types.js';
import { createCustomerId } from './primitives.js';
import { StripeProvider } from './providers/stripe-provider.js';
import { createFakeStripeHttp } from './providers/stripe-test-support.js';
import { observePayments } from './telemetry.js';

let spans: SpanCapture;
beforeAll(() => {
  spans = captureSpans();
});
beforeEach(() => spans.reset());
afterAll(() => spans[Symbol.dispose]());

/** The one span the scenario ended. */
function onlySpan() {
  expect(spans.finished).toHaveLength(1);
  const [span] = spans.finished;
  if (!span) throw new Error('no span ended');
  return span;
}

describe('observePayments', () => {
  const Refused = defineFailure('payments_test.refused');

  it('ends a payments.<operation> span with an unset status on success', async () => {
    expect(await observePayments('test.ok', { 'payments.provider': 'test' }, () => Promise.resolve(42))).toBe(42);

    const span = onlySpan();
    expect(span.name).toBe('payments.test.ok');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toEqual({ 'payments.provider': 'test' });
  });

  it('sets failure.code for a returned failure and keeps the span out of error', async () => {
    // WHY: dashboards group failures by `failure.code` across every @arki package; a payments-only
    // name hid payment refusals from them.
    const refused = Refused();

    expect(await observePayments('test.refused', {}, () => Promise.resolve(refused))).toBe(refused);

    const span = onlySpan();
    expect(span.attributes).toEqual({ 'failure.code': 'payments_test.refused' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records the exception, sets the error status and rethrows the same error', async () => {
    const down = new Error('down');

    await expect(observePayments('test.down', {}, () => Promise.reject(down))).rejects.toBe(down);

    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.map(event => event.name)).toEqual(['exception']);
  });
});

describe('StripeProvider spans', () => {
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
    return new StripeProvider(
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
  }

  it('names the span after the Stripe request and marks the provider', async () => {
    const stripe = provider(() => ({ body: { id: 'cus_new', object: 'customer', created: 1_767_225_600 } }));

    orThrow(await stripe.createCustomer({ userId: 'usr_bob', email: 'bob@example.com' }));

    const span = onlySpan();
    expect(span.name).toBe('payments.stripe.customers.create');
    expect(span.attributes).toEqual({ 'payments.provider': 'stripe' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a declined card as payments.card_declined on a span that is not an error', async () => {
    const stripe = provider(() => ({
      status: 402,
      body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'no' } },
    }));

    const payment = await stripe.createPayment({
      customerId: customer.id,
      amount: money('5.00', 'USD'),
      paymentMethodId: 'pm_1',
    });

    expect(payment).toMatchObject({ code: 'payments.card_declined' });
    const span = onlySpan();
    expect(span.name).toBe('payments.stripe.payment_intents.create');
    // Only the provider and the code: no amount, customer, card or payment method reaches the span.
    expect(span.attributes).toEqual({ 'payments.provider': 'stripe', 'failure.code': 'payments.card_declined' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('marks the span as an error when Stripe rejects the request', async () => {
    const stripe = provider(() => ({
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'No such customer', code: 'resource_missing' } },
    }));

    await expect(stripe.deleteCustomer(customer.id)).rejects.toMatchObject({ name: 'PaymentProviderError' });

    const span = onlySpan();
    expect(span.name).toBe('payments.stripe.customers.delete');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
