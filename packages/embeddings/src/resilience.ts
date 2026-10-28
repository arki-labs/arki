import type { Backoff, Policy, RetryFailure } from '@arki/resilience';
import { invariant } from '@arki/failure';
import { backoff, createResiliencePolicy, isResilienceError, RESILIENCE_ERROR_CODES } from '@arki/resilience';

import type { EmbedFailure } from './failures.js';
import type { Embedder, EmbeddingBatch, EmbedMiddleware } from './types.js';
import { Cancelled, isEmbedFailure, ModelUnavailable, RateLimited } from './failures.js';
import { withMiddleware } from './middleware.js';

/**
 * The only failures another try can fix: the provider was busy, or could not be reached. Every
 * other one (bad input, bad key, bad output, a cancel) fails the same way again and burns quota.
 */
function isRetryable(failure: EmbedFailure): boolean {
  return RateLimited.is(failure) || (ModelUnavailable.is(failure) && failure.data.reason === 'unreachable');
}

/** The default backoff's longest wait, and the longest `retryAfterMs` the default policy waits out. */
const MAX_BACKOFF_MS = 5000;

/**
 * `base`, but never shorter than the `retryAfterMs` a `RateLimited` asked for. One that asks for
 * more than `MAX_BACKOFF_MS` is not retried: the `RateLimited` goes back so the caller decides.
 */
function atLeastRetryAfter(base: Backoff): Backoff {
  return {
    // Built last, so the policy never calls the copied `upTo` and `while` on it.
    ...base,
    delay(attempt, reason) {
      const wait = base.delay(attempt, reason);
      if (wait === undefined || !RateLimited.is(reason)) return wait;
      const asked = reason.data.retryAfterMs ?? 0;
      // Sleeping an hour (or past the clock's limit) inside a library call is never what the caller wants.
      return asked > MAX_BACKOFF_MS ? undefined : Math.max(wait, asked);
    },
  };
}

/**
 * The default policy: `externalApiPolicy`'s retry and breaker, retrying the two retryable failures
 * and waiting at least `retryAfterMs` (up to 5 s; a longer one is not retried). Its timeout is 60 s, not 10 s: a local model embedding a full
 * batch, or loading first, takes longer than 10 s.
 */
function embeddingPolicy() {
  return createResiliencePolicy({
    retry: atLeastRetryAfter(
      backoff
        .exponential({ base: 200, max: MAX_BACKOFF_MS, jitter: 0.25 })
        .upTo(3)
        .while(RateLimited, ModelUnavailable),
    ),
    circuitBreaker: { consecutiveFailures: 5, halfOpenAfter: 30_000 },
    timeout: { timeoutMs: 60_000 },
  });
}

/** What one attempt settled on. A retryable failure is returned bare instead, so the policy can retry it. */
type Settled = { readonly settled: EmbeddingBatch | EmbedFailure };

function resilience(policy: Policy<never, RetryFailure>): EmbedMiddleware {
  return (next, embedder) => async (inputs, options) => {
    try {
      const outcome = await policy.execute(async ({ signal, attempt }): Promise<Settled | EmbedFailure> => {
        const result = await next(inputs, { ...options, signal });
        if (isEmbedFailure(result)) return isRetryable(result) ? result : { settled: result };
        // Each earlier attempt was a request too, and was charged.
        return { settled: { ...result, usage: { ...result.usage, requests: result.usage.requests + attempt } } };
      }, options.signal);
      if ('settled' in outcome) return outcome.settled;
      if (isEmbedFailure(outcome)) return outcome;
      // Cancellation is owned by retry or its clock wait; the embedding boundary keeps its own cancellation.
      invariant(options.signal?.aborted === true, () => `retry execution failed: ${outcome.code}`);
      return Cancelled();
    } catch (error) {
      // A throw from `embed` itself is a bug and stays a throw; so is a policy built wrong.
      if (!isResilienceError(error) || error.code === RESILIENCE_ERROR_CODES.invalidBackoff) throw error;
      if (options.signal?.aborted) return Cancelled();
      // A deadline, an open circuit or a full bulkhead: the provider did not answer in time.
      return ModelUnavailable({ model: embedder.model.id, reason: 'unreachable' });
    }
  };
}

/**
 * The same embedder with each `embed` call run through a resilience policy. It retries only
 * `RateLimited` and `ModelUnavailable { reason: 'unreachable' }`;
 * every other failure comes back after one attempt. `usage.requests` counts every attempt. A timeout,
 * an open circuit or a full bulkhead is `ModelUnavailable { reason: 'unreachable' }`, a cancel is
 * `Cancelled`: nothing is thrown for them.
 *
 * Default policy: 3 retries from 200 ms doubling to 5 s with 25% jitter, a breaker that opens after
 * 5 consecutive thrown failures for 30 s, and 60 s per attempt. It waits at least a `RateLimited`'s
 * `retryAfterMs`; one over 5 s is not retried, the `RateLimited` comes back at once.
 *
 * A policy of your own retries what its backoff selects, so build it with
 * `.while(RateLimited, ModelUnavailable)`; it is never handed a failure that must not be retried. It
 * gets no `retryAfterMs` minimum: its backoff's `delay(attempt, reason)` must read
 * `reason.data.retryAfterMs` when `RateLimited.is(reason)` if it should honour it.
 *
 * @example
 * const embedder = withResilience(base); // embedMany(embedder, texts) now retries each chunk
 */
export function withResilience(
  embedder: Embedder,
  policy: Policy<never, RetryFailure> = embeddingPolicy(),
): Embedder {
  return withMiddleware(embedder, resilience(policy));
}
