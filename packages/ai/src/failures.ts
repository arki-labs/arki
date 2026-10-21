/**
 * The expected ways an `@arki/ai` call can be refused, each defined once. They are returned, not
 * thrown: a correct caller must branch on them. A provider that is down still throws.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

import { LLM_PROVIDERS } from './ai-service/provider-names';

/** The local rate limiter has no free slot, even after its own waits and retries.
 * @fix Wait retryAfterMs milliseconds, then try again.
 * @verify bun run test -- src/utils/rate-limiter.test.ts src/cost/budget-manager.test.ts
 */
export const RateLimited = defineFailure('ai.rate_limited', {
  status: 429,
  data: z.object({ retryAfterMs: z.number() }),
  message: 'Rate limit reached: retry after {retryAfterMs}ms',
  remediation: 'Wait retryAfterMs milliseconds, then try again.',
});
export type RateLimited = ReturnType<typeof RateLimited>;

/** The operation's estimated cost would take the user over the limit of one budget period.
 * @fix Wait for the budget period to reset, or raise its limit.
 * @verify bun run test -- src/utils/rate-limiter.test.ts src/cost/budget-manager.test.ts
 */
export const BudgetExceeded = defineFailure('ai.budget_exceeded', {
  status: 402,
  data: z.object({ period: z.string(), currentSpendUsd: z.number(), remainingUsd: z.number() }),
  message: 'The {period} budget would be exceeded: {currentSpendUsd} USD spent, {remainingUsd} USD left',
  remediation: 'Wait for the budget period to reset, or raise its limit.',
});
export type BudgetExceeded = ReturnType<typeof BudgetExceeded>;

/**
 * Why `probeLLMProvider` found a provider unusable: the server did not answer, the model is not
 * installed, or the provider's API key is not set.
 */
export const PROVIDER_PROBLEMS = ['unreachable', 'model_missing', 'missing_key'] as const;

/** The configured model provider cannot be used right now. `probeLLMProvider` returns it instead of throwing.
 * @fix For Ollama, start it (`ollama serve`) and pull the model (`ollama pull <model>`). For a cloud provider, set its API key.
 * @verify bun run test -- src/ai-service/probe.test.ts src/dot/index.test.ts
 */
export const ProviderUnavailable = defineFailure('ai.provider_unavailable', {
  status: 503,
  data: z.object({ provider: z.enum(LLM_PROVIDERS), model: z.string(), problem: z.enum(PROVIDER_PROBLEMS) }),
  message: '{provider}/{model} cannot be used: {problem}',
  remediation: 'For Ollama, start it and pull the model. For a cloud provider, set its API key.',
});
export type ProviderUnavailable = ReturnType<typeof ProviderUnavailable>;
