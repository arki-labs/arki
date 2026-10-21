import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';
import { backoff, createResiliencePolicy } from '@arki/resilience';

import type { EmbedFailure } from './failures.js';
import type { NativeEmbeddings, NativeRequest } from './types.js';
import { embedMany } from './embed.js';
import { createEmbedder } from './embedder.js';
import {
  ConfigurationFailure,
  InputTooLong,
  InvalidOutput,
  ModelUnavailable,
  RateLimited,
  UnsupportedInput,
} from './failures.js';
import { withMiddleware } from './middleware.js';
import { withResilience } from './resilience.js';
import { echoTexts, stubModel } from './tests/stub-model.js';

/** An embedder whose native call answers `failures` in order, then succeeds; `calls` counts the requests. */
function failingThen(...failures: EmbedFailure[]) {
  const state = { calls: 0 };
  const embedder = createEmbedder(
    stubModel((request: NativeRequest): Promise<NativeEmbeddings | EmbedFailure> => {
      const failure = failures[state.calls++];
      return failure === undefined ? echoTexts(request) : Promise.resolve(failure);
    }),
  );
  if (isFailure(embedder)) throw new Error(embedder.message);
  return { embedder, state };
}

/** Retries at once, so a test does not wait out the default backoff. */
const instantPolicy = () =>
  createResiliencePolicy({ retry: backoff.constant(0).upTo(3).while(RateLimited, ModelUnavailable) });

describe('withResilience', () => {
  // A provider that says "wait 300 ms" bans a caller that comes back sooner; the default backoff
  // (200 ms ± 25%) alone would be too early.
  it('retries RateLimited after retryAfterMs', async () => {
    const { embedder, state } = failingThen(RateLimited({ retryAfterMs: 300 }));
    const started = Date.now();
    const result = await embedMany(withResilience(embedder), ['a']);
    expect(isFailure(result)).toBe(false);
    expect(state.calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('retries an unreachable model but not one that is not pulled', async () => {
    const unreachable = failingThen(ModelUnavailable({ model: 'stub', reason: 'unreachable' }));
    expect(isFailure(await embedMany(withResilience(unreachable.embedder, instantPolicy()), ['a']))).toBe(false);
    expect(unreachable.state.calls).toBe(2);

    const notPulled = failingThen(ModelUnavailable({ model: 'stub', reason: 'not-pulled' }));
    const result = await embedMany(withResilience(notPulled.embedder, instantPolicy()), ['a']);
    expect(ModelUnavailable.is(result)).toBe(true);
    expect(notPulled.state.calls).toBe(1);
  });

  // Retrying bad input or a bad key burns quota and hides the bug: one attempt, then the failure.
  it.each([
    ['401', ConfigurationFailure({ message: 'openai refused the API key (401)' })],
    ['400', InputTooLong({ index: 0, tokens: { basis: 'unknown' }, max: 10 })],
    ['unsupported', UnsupportedInput({ index: 0, part: 'image' })],
    ['invalid output', InvalidOutput({ reason: 'zero-norm at index 0' })],
  ])('does not retry 401 or 400 failures: %s', async (_name, failure) => {
    const { embedder, state } = failingThen(failure, failure, failure);
    const result = await embedMany(withResilience(embedder, instantPolicy()), ['a']);
    expect(isFailure(result) && result.code).toBe(failure.code);
    expect(state.calls).toBe(1);
  });

  // Every attempt reached the provider and was charged; usage must say so.
  it('requests counts attempts', async () => {
    const { embedder } = failingThen(RateLimited({}), RateLimited({}));
    const result = await embedMany(withResilience(embedder, instantPolicy()), ['a']);
    expect(isFailure(result) ? result.code : result.usage.requests).toBe(3);
  });

  it('gives back the last retryable failure once retries run out', async () => {
    const { embedder, state } = failingThen(RateLimited({}), RateLimited({}), RateLimited({}), RateLimited({}));
    const result = await embedMany(withResilience(embedder, instantPolicy()), ['a']);
    expect(RateLimited.is(result)).toBe(true);
    expect(state.calls).toBe(4);
  });
});

describe('withMiddleware', () => {
  // Order decides behaviour (a cache outside a retry never retries a hit), so it must be the order written.
  it('the first middleware is outermost', async () => {
    const order: string[] = [];
    const { embedder } = failingThen();
    const wrapped = withMiddleware(
      embedder,
      next => async (inputs, options) => {
        order.push('outer in');
        const result = await next(inputs, options);
        order.push('outer out');
        return result;
      },
      next => async (inputs, options) => {
        order.push('inner in');
        const result = await next(inputs, options);
        order.push('inner out');
        return result;
      },
    );
    await wrapped.embed(['a'], {});
    expect(order).toEqual(['outer in', 'inner in', 'inner out', 'outer out']);
    expect(wrapped.space).toEqual(embedder.space);
  });
});
