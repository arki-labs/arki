import { observeEvent } from './observers.js';
import { Cancelled } from './errors.js';
import { executeRaw, ownExecution } from './engine.js';
import type { Policy, PolicyCallback, PolicyExecution } from './policy.js';

/**
 * Give a policy a last answer. When the policy's call fails, `fallback` gets the error and its
 * result becomes the result of the call. Put it outermost: inside `wrap` it would hide the errors
 * the retry needs, so `wrap` does not accept a policy with a fallback.
 *
 * A fallback never handles a returned refusal or cancellation. Exhausted callback throws
 * reach it unchanged before public defect normalization. To fall back on some errors only, rethrow the others:
 * `(error) => { if (!(error instanceof TypeError)) throw error; return cached; }`.
 *
 * `onSuccess` and `onFailure` are the inner policy's events.
 *
 * @example
 * ```ts
 * const quotes = withFallback(createResiliencePolicy(), () => null);
 * const quote = await quotes.execute(() => fetchQuote()); // Quote | null
 * ```
 */
export function withFallback<F, G = never, E = never>(
  policy: Policy<G, E>, fallback: (error: unknown) => F | PromiseLike<F>,
): Policy<G | F, E>;
export function withFallback<F, G = never, E = never>(
  policy: PolicyExecution<G, E>, fallback: (error: unknown) => F | PromiseLike<F>,
): PolicyExecution<G | F, E>;
export function withFallback<F, G = never, E = never>(
  policy: PolicyExecution<G, E> & Partial<Pick<Policy<G, E>, 'onSuccess' | 'onFailure'>>,
  fallback: (error: unknown) => F | PromiseLike<F>,
) {
  const execution: PolicyExecution<G | F, E> = {
    async execute<T>(fn: PolicyCallback<T>, signal?: AbortSignal) {
      try {
        return await executeRaw(policy, fn, signal);
      } catch (error) {
        if (signal?.aborted) return Cancelled({ cause: signal.reason });
        return await fallback(error);
      }
    },
  };
  return Object.assign(ownExecution(execution), {
    onSuccess: policy.onSuccess === undefined ? undefined : observeEvent(policy.onSuccess, policy),
    onFailure: policy.onFailure === undefined ? undefined : observeEvent(policy.onFailure, policy),
  });
}
