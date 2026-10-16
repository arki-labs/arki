/**
 * Retries, timeouts and aborts in the typed client. Why these tests matter: a client that retries
 * the wrong request charges a card twice, and one that hides a timeout behind a policy error makes
 * an outage hard to read. Each test runs a real `@arki/resilience` retry policy, which on its own
 * would retry any error, so they show that `retryOn`, not the policy, decides what is sent again.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Policy } from '@arki/resilience';
import { backoff, createRetryPolicy, withFallback } from '@arki/resilience';

import type { ClientPolicy } from '../client.js';
import { createClient, retryTransient } from '../client.js';
import { route } from '../contract.js';
import { HTTP_ERROR_CODES, HttpError } from '../error.js';

const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: z.object({ id: z.string() }),
  output: z.object({ id: z.string() }),
});
const payOrder = route.post('/orders/:id/pay', {
  id: 'orders.pay',
  params: z.object({ id: z.string() }),
  body: z.object({ amount: z.int() }),
  output: z.object({ paid: z.boolean() }),
});

/** Two retries after the first try, no wait. */
const policy = createRetryPolicy({ backoff: backoff.constant(0).upTo(2) });

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const unavailable = (): Response => json(503, { error: { code: 'ARKI_HTTP_E500', message: 'busy' } });

/** A fake fetch that answers from a script, one entry per call, and counts the calls. */
function scripted(...answers: (() => Response | Promise<Response>)[]) {
  const calls: string[] = [];
  const fetch = async (input: string): Promise<Response> => {
    calls.push(input);
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer === undefined) throw new Error('no scripted answer');
    return answer();
  };
  return { calls, fetch };
}

/** A fetch that never answers; it rejects only when its signal aborts, as a real fetch does. */
const hanging = (_input: string, init: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    });
  });

describe('retries through a policy', () => {
  it('retries a 503 on a GET and returns the answer that finally succeeds', async () => {
    const { calls, fetch } = scripted(unavailable, unavailable, () => json(200, { id: 'o1' }));
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch, policy });
    await expect(orders.getOrder({ params: { id: 'o1' } })).resolves.toEqual({ id: 'o1' });
    expect(calls).toHaveLength(3);
  });

  it('never retries a POST without an idempotency key: the first try may have charged the card', async () => {
    const { calls, fetch } = scripted(unavailable, () => json(200, { paid: true }));
    const orders = createClient({ payOrder }, { baseUrl: 'https://api.test', fetch, policy });
    await expect(orders.payOrder({ params: { id: 'o1' }, body: { amount: 5 } })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it('retries the same POST once it carries an idempotency key', async () => {
    const { calls, fetch } = scripted(unavailable, () => json(200, { paid: true }));
    const orders = createClient({ payOrder }, { baseUrl: 'https://api.test', fetch, policy });
    const paid = await orders.payOrder(
      { params: { id: 'o1' }, body: { amount: 5 } },
      { headers: { 'Idempotency-Key': 'pay-o1' } },
    );
    expect(paid).toEqual({ paid: true });
    expect(calls).toHaveLength(2);
  });

  it('when the policy gives up, the last answer surfaces with the server code', async () => {
    const { calls, fetch } = scripted(unavailable);
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch, policy });
    const failure = orders.getOrder({ params: { id: 'o1' } });
    await expect(failure).rejects.toBeInstanceOf(HttpError);
    await expect(failure).rejects.toMatchObject({ status: 503, code: 'ARKI_HTTP_E500', message: 'busy' });
    expect(calls).toHaveLength(3);
  });

  it('retries a network failure, but not another error, though the policy itself would retry both', async () => {
    const network = scripted(
      () => Promise.reject(new TypeError('fetch failed')),
      () => json(200, { id: 'o1' }),
    );
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch: network.fetch, policy });
    await expect(orders.getOrder({ params: { id: 'o1' } })).resolves.toEqual({ id: 'o1' });
    expect(network.calls).toHaveLength(2);

    const refused = scripted(() => Promise.reject(new Error('Private network addresses are not allowed.')));
    const guarded = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch: refused.fetch, policy });
    await expect(guarded.getOrder({ params: { id: 'o1' } })).rejects.toThrow('Private network');
    expect(refused.calls).toHaveLength(1);
  });

  it('a custom retryOn decides instead of the default', async () => {
    const { calls, fetch } = scripted(
      () => json(500, { error: { code: 'ARKI_HTTP_E500', message: 'flaky' } }),
      () => json(200, { id: 'o1' }),
    );
    const orders = createClient(
      { getOrder },
      {
        baseUrl: 'https://api.test',
        fetch,
        policy,
        retryOn: outcome => outcome.response?.status === 500 || retryTransient(outcome),
      },
    );
    await expect(orders.getOrder({ params: { id: 'o1' } })).resolves.toEqual({ id: 'o1' });
    expect(calls).toHaveLength(2);
  });

  it('without a policy, nothing is retried', async () => {
    const { calls, fetch } = scripted(unavailable, () => json(200, { id: 'o1' }));
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch });
    await expect(orders.getOrder({ params: { id: 'o1' } })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });
});

describe('timeouts and aborts', () => {
  it('timeoutMs throws 408 ARKI_HTTP_E408, with or without a policy', async () => {
    for (const options of [{}, { policy }]) {
      const orders = createClient(
        { getOrder },
        { baseUrl: 'https://api.test', fetch: hanging, timeoutMs: 20, ...options },
      );
      await expect(orders.getOrder({ params: { id: 'o1' } })).rejects.toMatchObject({
        status: 408,
        code: HTTP_ERROR_CODES.requestTimeout,
      });
    }
  });

  it('a caller abort rejects with the caller reason and is not retried', async () => {
    let calls = 0;
    const fetch = (input: string, init: RequestInit): Promise<Response> => {
      calls += 1;
      return hanging(input, init);
    };
    const orders = createClient({ getOrder }, { baseUrl: 'https://api.test', fetch, policy, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = orders.getOrder({ params: { id: 'o1' } }, { signal: controller.signal });
    controller.abort(new Error('user left the page'));
    await expect(pending).rejects.toThrow('user left the page');
    expect(calls).toBe(1);
  });
});

describe('ClientPolicy', () => {
  it('accepts an @arki/resilience policy, but not one with a fallback: its result might not be a response', () => {
    expectTypeOf(policy).toExtend<ClientPolicy>();
    const cached = withFallback(policy, () => 'cached');
    expectTypeOf<typeof cached>().toEqualTypeOf<Policy<string>>();
    expectTypeOf(cached).not.toExtend<ClientPolicy>();
  });
});
