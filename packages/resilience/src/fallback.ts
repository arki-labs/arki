import type { Policy, PolicyCallback } from './policy.js';

/**
 * Give a policy a last answer. When the policy's call fails, `fallback` gets the error and its
 * result becomes the result of the call. Put it outermost: inside `wrap` it would hide the errors
 * the retry needs, so `wrap` does not accept a policy with a fallback.
 *
 * A fallback never hides a cancel: when the caller's signal is aborted, the error is rethrown
 * and `fallback` does not run. To fall back on some errors only, rethrow the others:
 * `(error) => { if (!isBrokenCircuitError(error)) throw error; return cached; }`.
 *
 * `onSuccess` and `onFailure` are the inner policy's events.
 *
 * @example
 * ```ts
 * const quotes = withFallback(createResiliencePolicy(), () => null);
 * const quote = await quotes.execute(() => fetchQuote()); // Quote | null
 * ```
 */
export function withFallback<F, G = never>(
  policy: Policy<G>,
  fallback: (error: unknown) => F | PromiseLike<F>,
): Policy<G | F> {
  return {
    onSuccess: policy.onSuccess,
    onFailure: policy.onFailure,
    async execute<T>(fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T | G | F> {
      try {
        return await policy.execute(fn, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return await fallback(error);
      }
    },
  };
}
