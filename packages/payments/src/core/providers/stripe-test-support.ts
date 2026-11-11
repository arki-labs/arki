import Stripe from 'stripe';

import { isFailure } from '@arki/failure';

import { StripeProvider } from './stripe-provider.js';

/** One request the Stripe SDK sent, as Stripe would have received it. */
export type RecordedStripeRequest = {
  method: string;
  /** Path after the host, such as `/v1/subscriptions/sub_1`. */
  path: string;
  /** The form body, with Stripe's bracket keys such as `items[0][price]`. */
  form: Record<string, string>;
  headers: Record<string, string>;
};

type FakeAnswer = { status?: number; body: unknown };

/**
 * A Stripe HTTP layer that never opens a socket. Every request is recorded and answered by `respond`.
 * Pass `client` as `httpClient` to `StripeProvider` (or `new Stripe`).
 */
export function createFakeStripeHttp(respond: (request: RecordedStripeRequest) => FakeAnswer): {
  client: Stripe.HttpClient;
  requests: RecordedStripeRequest[];
} {
  const requests: RecordedStripeRequest[] = [];

  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      headers[key.toLowerCase()] = value;
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    const form: Record<string, string> = {};
    // GET and DELETE params travel in the query string, POST params in the body
    for (const [key, value] of [...url.searchParams, ...new URLSearchParams(body)]) form[key] = value;

    const request: RecordedStripeRequest = { method: init?.method ?? 'GET', path: url.pathname, form, headers };
    requests.push(request);

    const answer = respond(request);
    return Promise.resolve(
      Response.json(answer.body, {
        status: answer.status ?? 200,
        headers: { 'request-id': 'req_fake' },
      }),
    );
  };

  return { client: Stripe.createFetchHttpClient(fakeFetch), requests };
}

/**
 * A `StripeProvider` for a test: `StripeProvider.create` with the config failure thrown, since a test
 * that builds a provider with a good setting must get one.
 */
export function stripeProviderOf(...args: Parameters<typeof StripeProvider.create>): StripeProvider {
  const provider = StripeProvider.create(...args);
  if (isFailure(provider)) throw new Error(`Test provider config rejected: ${provider.code}`);
  return provider;
}

/**
 * Amounts Stripe can send that are not a `Money`, each with the exact `@arki/money` code a read returns:
 * `[code, what, Stripe currency, Stripe amount]`. Stripe's JSON types an amount as an integer, but the SDK
 * passes on whatever the JSON holds, so text is in the list too. `money.rounding_necessary`,
 * `money.invalid_shape`, `money.unsupported_locale` and `money.invalid_rate` cannot come from a read.
 */
export const STRIPE_READ_AMOUNT_CASES = [
  ['money.unknown_currency', 'a currency outside ISO 4217', 'zzz', 1500],
  ['money.provider_amount', 'a currency Stripe has no amount rule for (KWD: 3 decimals)', 'kwd', 1000],
  ['money.provider_amount', 'units off the Stripe rule (ISK: whole kronur in two decimals)', 'isk', 150],
  ['money.out_of_range', 'a fraction of a Stripe unit (5.5 JPY)', 'jpy', 5.5],
  ['money.out_of_range', 'past 2^53 Stripe units', 'usd', 1e21],
  ['money.invalid_text', 'text that is not a whole number', 'usd', 'ten'],
  ['money.input_too_large', 'text longer than 1,000 characters', 'usd', '1'.repeat(1001)],
] as const;

/**
 * The read cases, plus one only a read that fills a minor-unit column has: a Stripe amount within 2^53 that is
 * past 2^53 - 1 of our minor units (MGA is whole ariary at Stripe and 2 decimals in ISO 4217).
 */
export const STRIPE_STORED_AMOUNT_CASES = [
  ...STRIPE_READ_AMOUNT_CASES,
  [
    'money.out_of_range',
    'past 2^53 - 1 minor units (MGA: one Stripe unit is 100 of ours)',
    'mga',
    Number.MAX_SAFE_INTEGER,
  ],
] as const;
