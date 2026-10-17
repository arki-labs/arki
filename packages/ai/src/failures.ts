/**
 * The expected ways an `@arki/ai` call can be refused, each defined once. They are returned, not
 * thrown: a correct caller must branch on them. A provider that is down still throws.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/** The local rate limiter has no free slot, even after its own waits and retries. */
export const RateLimited = defineFailure('ai.rate_limited', {
  status: 429,
  data: z.object({ retryAfterMs: z.number() }),
  message: 'Rate limit reached: retry after {retryAfterMs}ms',
  remediation: 'Wait retryAfterMs milliseconds, then try again.',
});
export type RateLimited = ReturnType<typeof RateLimited>;

/** The operation's estimated cost would take the user over the limit of one budget period. */
export const BudgetExceeded = defineFailure('ai.budget_exceeded', {
  status: 402,
  data: z.object({ period: z.string(), currentSpendUsd: z.number(), remainingUsd: z.number() }),
  message: 'The {period} budget would be exceeded: {currentSpendUsd} USD spent, {remainingUsd} USD left',
  remediation: 'Wait for the budget period to reset, or raise its limit.',
});
export type BudgetExceeded = ReturnType<typeof BudgetExceeded>;
