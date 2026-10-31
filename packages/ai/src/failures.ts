/**
 * The expected ways an `@arki/ai` call can be refused, each defined once. They are returned, not
 * thrown: a correct caller must branch on them. A provider that is down, slow or broken is returned
 * too (`ProviderFailed`); only a bug in this package or the caller is a thrown or returned defect.
 */
import { z } from '@arki/contracts';
import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import { LLM_PROVIDERS } from './ai-service/provider-names.js';

/** The local rate limiter has no free slot, or the provider answered 429. `retryAfterMs` is set
 * when the limiter or the provider's `Retry-After` header said how long to wait.
 * @fix Wait retryAfterMs milliseconds (when set), then try again.
 * @verify bun run test -- src/utils/rate-limiter.test.ts src/ai-service/provider-failure.test.ts
 */
export const RateLimited = /* @__PURE__ */ defineFailure('ai.rate_limited', {
  status: 429,
  data: z.object({ retryAfterMs: z.number().optional() }),
  message: 'Rate limit reached',
  remediation: 'Wait retryAfterMs milliseconds (when set), then try again.',
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

/**
 * Why a cost circuit breaker refused a call: it was already `open`, or this call's estimated cost
 * would take it over its cost threshold (`cost_threshold`, which also opens it).
 */
export const CIRCUIT_OPEN_REASONS = ['open', 'cost_threshold'] as const;

/** The cost circuit breaker refused the call; the operation did not run. `retryAfterMs` says when it half-opens.
 * @fix Wait retryAfterMs milliseconds and try again, or raise costThresholdUsd if the threshold is too low.
 * @verify bun run test -- src/cost/circuit-breaker.test.ts
 */
export const CircuitOpen = /* @__PURE__ */ defineFailure('ai.circuit_open', {
  status: 503,
  data: z.object({
    reason: z.enum(CIRCUIT_OPEN_REASONS),
    retryAfterMs: z.number(),
    cumulativeCostUsd: z.number(),
    costThresholdUsd: z.number(),
  }),
  message: 'The cost circuit breaker refused the call ({reason})',
  remediation: 'Wait retryAfterMs milliseconds and try again, or raise costThresholdUsd if the threshold is too low.',
});
export type CircuitOpen = ReturnType<typeof CircuitOpen>;

/** A search asked for `keyword` mode, but the `SemanticSearchService` was built with no keyword search provider.
 * @fix Pass a KeywordSearchProvider to the SemanticSearchService constructor, or search in `semantic` mode.
 * @verify bun run test -- src/semantic-search/search-service.test.ts
 */
export const KeywordSearchUnavailable = /* @__PURE__ */ defineFailure('ai.keyword_search_unavailable', {
  status: 500,
  message: 'Keyword search was asked for, but no keyword search provider is configured',
  remediation: 'Pass a KeywordSearchProvider to the SemanticSearchService constructor, or search in semantic mode.',
});
export type KeywordSearchUnavailable = ReturnType<typeof KeywordSearchUnavailable>;

/** Which provider and model a provider failure came from. */
const providerCall = { provider: z.string(), model: z.string() };

/** The provider refused the credentials (401 or 403), or no API key was set for it.
 * @fix Set a valid API key for the provider, or pick a provider you have access to.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts
 */
export const ProviderUnauthorized = /* @__PURE__ */ defineFailure('ai.unauthorized', {
  status: 401,
  data: z.object({ ...providerCall, status: z.number().optional() }),
  message: '{provider}/{model} refused the credentials',
  remediation: 'Set a valid API key for the provider, or pick a provider you have access to.',
});
export type ProviderUnauthorized = ReturnType<typeof ProviderUnauthorized>;

/** The provider's content filter stopped the answer, or the model refused to answer.
 * @fix Change the prompt, or show the user that the request was refused.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts
 */
export const ContentFiltered = /* @__PURE__ */ defineFailure('ai.content_filtered', {
  status: 422,
  data: z.object(providerCall),
  message: '{provider}/{model} refused to answer (content filter)',
  remediation: 'Change the prompt, or show the user that the request was refused.',
});
export type ContentFiltered = ReturnType<typeof ContentFiltered>;

/** The answer stopped early: the output token limit (`length`) or another non-`stop` finish.
 * @fix Raise maxTokens, shorten the prompt, or ask for a shorter answer.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts src/ai-service/factory.test.ts
 */
export const IncompleteGeneration = /* @__PURE__ */ defineFailure('ai.incomplete', {
  status: 502,
  data: z.object({ ...providerCall, finishReason: z.string() }),
  message: '{provider}/{model} stopped before the answer was complete ({finishReason})',
  remediation: 'Raise maxTokens, shorten the prompt, or ask for a shorter answer.',
});
export type IncompleteGeneration = ReturnType<typeof IncompleteGeneration>;

/** The model answered, but the answer is not usable: no text, malformed JSON, or JSON the schema rejects.
 * @fix Make the schema simpler, describe the fields in the prompt, or use a stronger model.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts src/ai-service/factory.test.ts
 */
export const InvalidOutput = /* @__PURE__ */ defineFailure('ai.invalid_output', {
  status: 502,
  data: z.object({ ...providerCall, reason: z.string() }),
  message: '{provider}/{model} gave an unusable answer: {reason}',
  remediation: 'Make the schema simpler, describe the fields in the prompt, or use a stronger model.',
});
export type InvalidOutput = ReturnType<typeof InvalidOutput>;

/** The provider could not answer: a server error, a timeout, a network failure, or a request it rejected.
 * @fix Retry later or fall back to another provider; a 4xx status means the request needs changing.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts
 */
export const ProviderFailed = /* @__PURE__ */ defineFailure('ai.provider_failed', {
  status: 502,
  data: z.object({ ...providerCall, status: z.number().optional() }),
  message: '{provider}/{model} could not answer',
  remediation: 'Retry later or fall back to another provider; a 4xx status means the request needs changing.',
});
export type ProviderFailed = ReturnType<typeof ProviderFailed>;

/** The caller aborted the call through its AbortSignal.
 * @fix Nothing to fix: start a new call if the answer is still needed.
 * @verify bun run test -- src/ai-service/provider-failure.test.ts
 */
export const Cancelled = /* @__PURE__ */ defineFailure('ai.cancelled', {
  status: 499,
  message: 'The AI call was cancelled',
  remediation: 'Nothing to fix: start a new call if the answer is still needed.',
});
export type Cancelled = ReturnType<typeof Cancelled>;

/** Every provider of a provider router failed or is tripped. `failures` lists each provider's failure code.
 * `retryAfterMs` is the shortest Retry-After wait among the rate-limited providers, when one said how long.
 * @fix Look at each provider's failure code: wait out rate limits, fix keys, or add a provider.
 * @verify bun run test -- src/ai-service/provider-router.test.ts
 */
export const AllProvidersFailed = /* @__PURE__ */ defineFailure('ai.all_providers_failed', {
  status: 503,
  data: z.object({
    failures: z.array(z.object({ provider: z.string(), code: z.string() })),
    retryAfterMs: z.number().optional(),
  }),
  message: 'Every provider failed',
  remediation: "Look at each provider's failure code: wait out rate limits, fix keys, or add a provider.",
});
export type AllProvidersFailed = ReturnType<typeof AllProvidersFailed>;

/** A provider router was built with no provider that can run (none enabled, or none has an API key).
 * @fix Enable a provider and set its API key, or run Ollama locally.
 * @verify bun run test -- src/ai-service/provider-router.test.ts
 */
export const NoProviderConfigured = /* @__PURE__ */ defineFailure('ai.no_provider_configured', {
  status: 500,
  message: 'No AI provider is configured',
  remediation: 'Enable a provider and set its API key, or run Ollama locally.',
});
export type NoProviderConfigured = ReturnType<typeof NoProviderConfigured>;

/** The connection to an AI endpoint broke before the answer was complete: the request failed, the body
 * stopped mid-read, or a run's event stream ended without a `run:finish` or `run:error`.
 * @fix Retry; if it keeps happening, check the network and the endpoint's logs.
 * @verify bun run test -- src/runtime/sse.test.ts src/react/hooks/hooks.test.ts
 */
export const ConnectionLost = /* @__PURE__ */ defineFailure('ai.connection_lost', {
  status: 502,
  message: 'The connection to the AI endpoint was lost before the answer was complete',
  remediation: "Retry; if it keeps happening, check the network and the endpoint's logs.",
});
export type ConnectionLost = ReturnType<typeof ConnectionLost>;

/** The input sanitizer blocked the prompt (for example a prompt injection attempt), so no request was sent.
 * @fix Show the user that the input was refused, or change the sanitizer's rules if this input is allowed.
 * @verify bun run test -- src/ai-service/openai-service.test.ts
 */
export const InputBlocked = /* @__PURE__ */ defineFailure('ai.input_blocked', {
  status: 422,
  data: z.object({ reason: z.string() }),
  message: 'The input was blocked: {reason}',
  remediation: "Show the user that the input was refused, or change the sanitizer's rules if this input is allowed.",
});
export type InputBlocked = ReturnType<typeof InputBlocked>;

/** The model answered in the right shape, but the answer is not backed by its source: a summary or
 * passage that is not in the transcript, an unknown reference, a rejected self-review, or an order
 * that drops or repeats an item. `reason` says which check refused it.
 * @fix Retry, use a stronger model, or show the user that no grounded answer was found.
 * @verify bun run test -- src/capabilities/episode-analysis.test.ts src/capabilities/queue.test.ts src/capabilities/ask.test.ts
 */
export const UngroundedOutput = /* @__PURE__ */ defineFailure('ai.ungrounded_output', {
  status: 422,
  data: z.object({ reason: z.string() }),
  message: 'The model answer is not grounded in its source: {reason}',
  remediation: 'Retry, use a stronger model, or show the user that no grounded answer was found.',
});
export type UngroundedOutput = ReturnType<typeof UngroundedOutput>;

/** A flow node ran longer than its `timeoutMs`. The node is not retried: it may still be stopping.
 * @fix Raise the node's timeoutMs, or make the node faster.
 * @verify bun run test -- src/orchestration/flow.failures.test.ts
 */
export const FlowTimedOut = /* @__PURE__ */ defineFailure('ai.flow_timed_out', {
  status: 504,
  data: z.object({ nodeId: z.string(), timeoutMs: z.number() }),
  message: 'Flow node {nodeId} timed out after {timeoutMs}ms',
  remediation: "Raise the node's timeoutMs, or make the node faster.",
});
export type FlowTimedOut = ReturnType<typeof FlowTimedOut>;

/** A flow took more steps than its `maxSteps`, usually a `next` that loops.
 * @fix Make the loop end, or raise maxSteps.
 * @verify bun run test -- src/orchestration/flow.failures.test.ts
 */
export const FlowStepLimitReached = /* @__PURE__ */ defineFailure('ai.flow_step_limit', {
  status: 508,
  data: z.object({ nodeId: z.string(), maxSteps: z.number() }),
  message: 'Flow stopped at node {nodeId}: more than {maxSteps} steps',
  remediation: 'Make the loop end, or raise maxSteps.',
});
export type FlowStepLimitReached = ReturnType<typeof FlowStepLimitReached>;

/** A flow node still threw after all its attempts. The last error is the `cause`.
 * @fix Read the cause; fix the node or raise its retries.
 * @verify bun run test -- src/orchestration/flow.failures.test.ts
 */
export const FlowNodeFailed = /* @__PURE__ */ defineFailure('ai.flow_node_failed', {
  status: 500,
  data: z.object({ nodeId: z.string(), attempts: z.number() }),
  message: 'Flow node {nodeId} failed after {attempts} attempt(s)',
  remediation: 'Read the cause; fix the node or raise its retries.',
});
export type FlowNodeFailed = ReturnType<typeof FlowNodeFailed>;

/** The vector index, or the database behind it, could not be reached or refused the call. `reason` is the underlying message.
 * @fix Check that the vector store (Qdrant) is up and reachable; the reconciler tries again on its next run.
 * @verify bun run test -- src/vector-search/reconcile.test.ts
 */
export const VectorStoreUnavailable = /* @__PURE__ */ defineFailure('ai.vector_store_unavailable', {
  status: 503,
  data: z.object({ operation: z.string(), reason: z.string() }),
  message: '{operation} failed because the vector store is unavailable: {reason}',
  remediation: 'Check that the vector store is up and reachable; the reconciler tries again on its next run.',
});
export type VectorStoreUnavailable = ReturnType<typeof VectorStoreUnavailable>;

/**
 * Every failure a provider call returns: the refusals above plus `UnexpectedDefect` for a throw
 * this package does not know (a bug, never an expected outcome).
 */
export const PROVIDER_FAILURES = [
  RateLimited,
  ProviderUnauthorized,
  ContentFiltered,
  IncompleteGeneration,
  InvalidOutput,
  ProviderFailed,
  Cancelled,
  UnexpectedDefect,
] as const;

/** One of {@link PROVIDER_FAILURES}. */
export type ProviderFailure = ReturnType<(typeof PROVIDER_FAILURES)[number]>;

/** True when `value` is one of {@link PROVIDER_FAILURES}. */
export function isProviderFailure(value: unknown): value is ProviderFailure {
  return isFailure(value) && PROVIDER_FAILURES.some(definition => definition.is(value));
}
