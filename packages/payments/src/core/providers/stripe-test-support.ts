import Stripe from 'stripe';

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
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : '';
    const form: Record<string, string> = {};
    // GET and DELETE params travel in the query string, POST params in the body
    for (const [key, value] of [...url.searchParams, ...new URLSearchParams(body)]) form[key] = value;

    const request: RecordedStripeRequest = { method: init?.method ?? 'GET', path: url.pathname, form, headers };
    requests.push(request);

    const answer = respond(request);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
      }),
    );
  };

  return { client: Stripe.createFetchHttpClient(fakeFetch), requests };
}
