/**
 * Provider Router for LLM Services
 *
 * Implements weighted round-robin rotation and automatic failover
 * between multiple LLM providers.
 */

import type { LanguageModel } from 'ai';
import { anthropic, createAnthropic } from '../anthropic.js';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral, mistral } from '@ai-sdk/mistral';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';

import type { ProviderFailure } from '../failures.js';
import type {
  GenerateOptions,
  LLMProvider,
  Message,
  ProviderConfig,
  ProviderHealth,
  ProviderResult,
  StreamOptions,
} from './types.js';
import { debugService } from '../debug.js';
import { env } from '../env.js';
import {
  AllProvidersFailed,
  isProviderFailure,
  NoProviderConfigured,
  ProviderFailed,
  ProviderUnauthorized,
  RateLimited,
} from '../failures.js';
import { DEFAULT_ANTHROPIC_MODEL } from './factory.js';
import { createGoogleService } from './google-service.js';
import { createGroqService } from './groq-service.js';
import { createMistralService } from './mistral-service.js';
import { createOpenRouterService } from './openrouter-service.js';
import { finishFailure, providerFailure, readTextParts } from './provider-failure.js';
import { aiTelemetry } from './telemetry.js';

/** What a router call returns when it does not succeed: one provider's final failure, or every provider's. */
export type ProviderRouterFailure = ProviderFailure | AllProvidersFailed;

/** Stream options for the router: `onError` gets the failure that ends the router's stream, never one it recovered from. */
export type ProviderRouterStreamOptions = Omit<StreamOptions, 'onError'> & {
  onError?: (failure: ProviderRouterFailure) => void;
};

/**
 * The failures that mean "this provider cannot serve right now": a rate limit, an outage, or a
 * refused key. Only these fall back to the next provider and count against provider health. A
 * bad key on one provider says nothing about the others, so it falls back too. `Cancelled` and
 * `UnexpectedDefect` stop the call; a refusal, a cut-off answer or an unusable answer is about
 * the request, not the provider, so it is returned as is (sending a refused prompt to the next
 * provider would shop it around).
 */
const PROVIDER_OUTAGES = [RateLimited, ProviderFailed, ProviderUnauthorized] as const;

/** One provider a fallback call tried, and how it failed. */
type ProviderAttempt = { provider: string; failure: ProviderFailure };

function isOutage(failure: ProviderFailure): boolean {
  return PROVIDER_OUTAGES.some(definition => definition.is(failure));
}

/**
 * Default models for each provider (free tier compatible)
 */
const DEFAULT_MODELS: Record<ProviderConfig['name'], string> = {
  groq: 'gemma2-9b-it',
  google: 'gemini-1.5-flash',
  mistral: 'mistral-small-latest',
  openrouter: 'meta-llama/llama-3.2-3b-instruct:free',
  openai: 'gpt-4o-mini',
  anthropic: DEFAULT_ANTHROPIC_MODEL,
};

function resolveModel(config: ProviderConfig): string {
  if (config.model.length > 0) {
    return config.model;
  }

  return DEFAULT_MODELS[config.name];
}

function getProviderApiKey(name: ProviderConfig['name']): string | undefined {
  switch (name) {
    case 'anthropic': {
      return env.ANTHROPIC_API_KEY;
    }
    case 'openai': {
      return env.OPENAI_API_KEY;
    }
    case 'google': {
      return env.GOOGLE_GENERATIVE_AI_API_KEY;
    }
    case 'groq': {
      return env.GROQ_API_KEY;
    }
    case 'mistral': {
      return env.MISTRAL_API_KEY;
    }
    case 'openrouter': {
      return env.OPENROUTER_API_KEY;
    }
  }
}

function hasConfiguredCredentials(config: ProviderConfig): boolean {
  return Boolean(config.apiKey ?? getProviderApiKey(config.name));
}

/**
 * Create an AI SDK LanguageModel from a provider config.
 *
 * Maps our internal provider names to the corresponding `@ai-sdk/*` factory
 * functions. When a custom `apiKey` is provided on the config, we use the
 * provider's factory (`createGoogleGenerativeAI`, `createAnthropic`, etc.)
 * to create an isolated instance with that key. Otherwise we fall back to
 * the default singletons which read from environment variables.
 */
function createLanguageModel(config: ProviderConfig): LanguageModel {
  const { name, apiKey } = config;
  const model = resolveModel(config);

  switch (name) {
    case 'anthropic': {
      if (apiKey) {
        return createAnthropic({ apiKey })(model);
      }
      return anthropic(model);
    }
    case 'openai': {
      if (apiKey) {
        return createOpenAI({ apiKey })(model);
      }
      return openai(model);
    }
    case 'google': {
      if (apiKey) {
        return createGoogleGenerativeAI({ apiKey })(model);
      }
      return google(model);
    }
    case 'groq': {
      const groq = createGroq({ apiKey: apiKey ?? env.GROQ_API_KEY });
      return groq(model);
    }
    case 'mistral': {
      if (apiKey) {
        return createMistral({ apiKey })(model);
      }
      return mistral(model);
    }
    case 'openrouter': {
      const openrouter = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: apiKey ?? env.OPENROUTER_API_KEY,
      });
      return openrouter(model);
    }
  }
}

/**
 * An `LLMProvider` over the AI SDK for one provider config. Every call returns its failure through
 * the shared boundary (`providerFailure`, `finishFailure`, `readTextParts`) and is traced through
 * `aiTelemetry`, like the `LanguageModelAdapter`.
 */
function createLanguageModelProvider(config: ProviderConfig, defaultTemperature: number): LLMProvider {
  const model = resolveModel(config);
  const maxRetries = 2;
  const call = (options: GenerateOptions) => ({ provider: config.name, model, signal: options.signal });
  const missingKey = (): ProviderFailure | undefined =>
    hasConfiguredCredentials(config) ? undefined : ProviderUnauthorized({ provider: config.name, model });
  const callOptions = (options: GenerateOptions, operation: string) => ({
    model: createLanguageModel(config),
    temperature: options.temperature ?? defaultTemperature,
    maxOutputTokens: options.maxTokens,
    maxRetries: options.maxRetries ?? maxRetries,
    stopSequences: options.stopSequences,
    abortSignal: options.signal,
    ...aiTelemetry(`${config.name}.${operation}`),
  });

  /** Read a started stream to its end, calling the stream callbacks; a failure is the last item. */
  async function* textOf(
    open: () => ReturnType<typeof streamText>,
    options: StreamOptions,
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    const missing = missingKey();
    if (missing) {
      options.onError?.(missing);
      yield missing;
      return;
    }
    let stream: ReturnType<typeof streamText>;
    try {
      stream = open();
    } catch (error) {
      const failure = providerFailure(error, call(options));
      options.onError?.(failure);
      yield failure;
      return;
    }
    let text = '';
    for await (const chunk of readTextParts(stream.fullStream, call(options))) {
      if (typeof chunk !== 'string') {
        options.onError?.(chunk);
        yield chunk;
        return;
      }
      text += chunk;
      options.onChunk?.(chunk);
      yield chunk;
    }
    options.onComplete?.(text);
  }

  return {
    name: config.name,
    model,
    isAvailable: () => hasConfiguredCredentials(config),
    generateText: async (prompt, options = {}) => {
      const missing = missingKey();
      if (missing) return missing;
      try {
        const result = await generateText({
          ...callOptions(options, 'generateText'),
          instructions: options.systemPrompt,
          prompt,
        });
        return finishFailure(result.finishReason, call(options)) ?? result.text;
      } catch (error) {
        return providerFailure(error, call(options));
      }
    },
    generateConversation: async (messages, options = {}) => {
      const missing = missingKey();
      if (missing) return missing;
      try {
        const result = await generateText({
          ...callOptions(options, 'generateConversation'),
          messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        });
        return finishFailure(result.finishReason, call(options)) ?? result.text;
      } catch (error) {
        return providerFailure(error, call(options));
      }
    },
    streamText: (prompt, options = {}) =>
      textOf(
        () => streamText({ ...callOptions(options, 'streamText'), instructions: options.systemPrompt, prompt }),
        options,
      ),
    streamConversation: (messages, options = {}) =>
      textOf(
        () =>
          streamText({
            ...callOptions(options, 'streamConversation'),
            messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
          }),
        options,
      ),
  };
}

/**
 * Result from resolving a LanguageModel via the router.
 */
export type ResolvedLanguageModel = {
  /** The AI SDK LanguageModel ready for use with streamText/generateText */
  model: LanguageModel;
  /** The provider that was selected */
  providerName: ProviderConfig['name'];
};

/**
 * Configuration for the ProviderRouter
 */
export type ProviderRouterConfig = {
  /** List of provider configurations */
  providers: ProviderConfig[];
  /** Maximum consecutive failures before marking provider as unhealthy */
  maxConsecutiveFailures?: number;
  /** Time in ms to wait before retrying an unhealthy provider */
  healthCheckIntervalMs?: number;
  /** Default temperature for all providers */
  defaultTemperature?: number;
};

/**
 * Provider Router
 *
 * Manages multiple LLM providers with:
 * - Weighted round-robin selection
 * - Failover to the next provider on an outage (`RateLimited`, `ProviderFailed`, `ProviderUnauthorized`)
 * - Health tracking and recovery
 *
 * Build it with `createProviderRouter` (or `ProviderRouter.create`): a config with no usable
 * provider returns `NoProviderConfigured` there, at boot, instead of a router that fails every call.
 * Every call returns its failure; nothing is thrown.
 */
export class ProviderRouter {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly configs: ProviderConfig[];
  private readonly healthStatus = new Map<string, ProviderHealth>();
  /** The failure that last counted against each provider, for `AllProvidersFailed`. */
  private readonly lastFailures = new Map<string, ProviderFailure>();
  private readonly maxConsecutiveFailures: number;
  private readonly healthCheckIntervalMs: number;
  private currentIndex = 0;
  private totalWeight = 0;

  /** Private: `create` checks that at least one provider can run. */
  private constructor(config: ProviderRouterConfig) {
    this.configs = config.providers.filter(p => p.enabled !== false);
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 60_000;

    for (const providerConfig of this.configs) {
      const provider = this.createProvider(providerConfig, config.defaultTemperature);

      if (provider.isAvailable()) {
        this.providers.set(providerConfig.name, provider);
        this.healthStatus.set(providerConfig.name, {
          isHealthy: true,
          consecutiveFailures: 0,
        });
        this.totalWeight += providerConfig.weight ?? 1;

        debugService.debug('[ProviderRouter] Registered provider: {provider} (model: {model}, weight: {weight})', {
          provider: providerConfig.name,
          model: providerConfig.model,
          weight: providerConfig.weight ?? 1,
        });
      } else {
        debugService.debug('[ProviderRouter] Skipping unavailable provider: {provider}', {
          provider: providerConfig.name,
        });
      }
    }
  }

  /**
   * Build a router, or return `NoProviderConfigured` when no provider is enabled with an API key.
   * This is a configuration fault: check it at boot.
   */
  static create(config: ProviderRouterConfig): ProviderRouter | NoProviderConfigured {
    const router = new ProviderRouter(config);
    if (router.providers.size === 0) {
      debugService.debug('[ProviderRouter] No provider is enabled with an API key ({listed} listed)', {
        listed: config.providers.length,
      });
      return NoProviderConfigured();
    }
    debugService.debug('[ProviderRouter] Initialized with {providersSize} providers (total weight: {weight})', {
      providersSize: router.providers.size,
      weight: router.totalWeight,
    });
    return router;
  }

  /**
   * Create a provider instance based on config
   */
  private createProvider(config: ProviderConfig, defaultTemperature?: number): LLMProvider {
    const model = resolveModel(config);
    const temperature = defaultTemperature ?? 0.7;

    // Use AI SDK-native provider wrapper when API key override is provided
    // or for providers that do not have dedicated LLMProvider services here.
    if (config.apiKey || config.name === 'openai' || config.name === 'anthropic') {
      return createLanguageModelProvider({ ...config, model }, temperature);
    }

    switch (config.name) {
      case 'groq': {
        return createGroqService({ model, temperature });
      }
      case 'google': {
        return createGoogleService({ model, temperature });
      }
      case 'mistral': {
        return createMistralService({ model, temperature });
      }
      case 'openrouter': {
        return createOpenRouterService({ model, temperature });
      }
    }
  }

  /**
   * Get all healthy provider configs that are currently available.
   */
  private getHealthyConfigs(): ProviderConfig[] {
    return this.configs.filter(
      config => this.providers.has(config.name) && this.healthStatus.get(config.name)?.isHealthy !== false,
    );
  }

  /**
   * Select the next config using weighted round-robin.
   */
  private selectNextWeightedConfig(configs: ProviderConfig[]): ProviderConfig | null {
    if (configs.length === 0) {
      return null;
    }

    const normalized = configs.map(config => ({
      config,
      weight: Math.max(1, config.weight ?? 1),
    }));

    const totalWeight = normalized.reduce((total, item) => total + item.weight, 0);

    if (totalWeight === 0) {
      return null;
    }

    const slot = this.currentIndex % totalWeight;
    this.currentIndex = (this.currentIndex + 1) % totalWeight;

    let cumulativeWeight = 0;

    for (const item of normalized) {
      cumulativeWeight += item.weight;
      if (slot < cumulativeWeight) {
        return item.config;
      }
    }

    return normalized.at(-1)?.config ?? null;
  }

  /**
   * The providers one fallback call tries, each once: the healthy ones (the first picked by
   * weighted round-robin, the rest in config order), then the tripped ones whose health check
   * interval has passed (a half-open retry: one more outage trips them again).
   */
  private attemptOrder(): LLMProvider[] {
    const healthy = this.getHealthyConfigs();
    const first = this.selectNextWeightedConfig(healthy);
    const now = Date.now();
    const recoverable = this.configs.filter(config => {
      const health = this.healthStatus.get(config.name);
      return (
        this.providers.has(config.name) &&
        health?.isHealthy === false &&
        health.lastFailure !== undefined &&
        now - health.lastFailure.getTime() > this.healthCheckIntervalMs
      );
    });
    const ordered = [...(first ? [first] : []), ...healthy.filter(config => config !== first), ...recoverable];
    return ordered.flatMap(config => this.providers.get(config.name) ?? []);
  }

  /**
   * `AllProvidersFailed` for the providers this call tried, plus every provider it skipped because
   * it is tripped (with the failure that tripped it). `retryAfterMs` is the shortest Retry-After.
   */
  private allFailed(attempts: readonly ProviderAttempt[]): AllProvidersFailed {
    const tried = new Set(attempts.map(attempt => attempt.provider));
    const skipped = [...this.providers.keys()].flatMap(provider => {
      const failure = this.lastFailures.get(provider);
      return tried.has(provider) || !failure ? [] : [{ provider, failure }];
    });
    const all = [...attempts, ...skipped];
    const waits = all.flatMap(({ failure }) =>
      RateLimited.is(failure) && failure.data.retryAfterMs !== undefined ? [failure.data.retryAfterMs] : [],
    );
    debugService.debug('[ProviderRouter] Every provider failed: {codes}', {
      codes: all.map(({ provider, failure }) => `${provider}=${failure.code}`).join(', '),
    });
    return AllProvidersFailed(
      {
        failures: all.map(({ provider, failure }) => ({ provider, code: failure.code })),
        ...(waits.length > 0 ? { retryAfterMs: Math.min(...waits) } : {}),
      },
      { cause: all.map(({ failure }) => failure) },
    );
  }

  /**
   * Get the next healthy provider using weighted round-robin
   */
  getNextProvider(): LLMProvider | null {
    const healthyConfigs = this.getHealthyConfigs();

    if (healthyConfigs.length === 0) {
      // Try to recover an unhealthy provider
      const recoveredProvider = this.tryRecoverProvider();
      if (recoveredProvider) {
        return recoveredProvider;
      }
      return null;
    }

    const config = this.selectNextWeightedConfig(healthyConfigs);
    if (!config) {
      return null;
    }

    const provider = this.providers.get(config.name);
    debugService.debug('[ProviderRouter] Selected provider: {provider}', { provider: config.name });

    return provider ?? null;
  }

  /**
   * Try to recover an unhealthy provider after the health check interval
   */
  private tryRecoverProvider(): LLMProvider | null {
    const now = Date.now();

    for (const [name, health] of this.healthStatus) {
      if (!health.isHealthy && health.lastFailure && now - health.lastFailure.getTime() > this.healthCheckIntervalMs) {
        debugService.debug('[ProviderRouter] Attempting to recover provider: {provider}', { provider: name });

        // Reset health status for retry
        this.healthStatus.set(name, {
          isHealthy: true,
          consecutiveFailures: 0,
          lastSuccess: health.lastSuccess,
        });

        return this.providers.get(name) ?? null;
      }
    }

    return null;
  }

  /**
   * Report a failure for a provider, for calls made outside the router (for example `streamText`
   * on the model from `toLanguageModel`). Pass the `ProviderFailure` or the raw error the AI SDK
   * gave you: it is mapped through the same boundary as the router's own calls. Only an outage
   * (`RateLimited`, `ProviderFailed`, `ProviderUnauthorized`) counts against the provider's
   * health; a cancel or a bug does not.
   */
  reportFailure(providerName: string, error: unknown): void {
    const provider = this.providers.get(providerName);
    if (!provider) return;
    const failure = isProviderFailure(error)
      ? error
      : providerFailure(error, { provider: providerName, model: provider.model });
    if (isOutage(failure)) this.recordOutage(providerName, failure);
  }

  /** Count one outage against a provider; it is tripped after `maxConsecutiveFailures` in a row. */
  private recordOutage(providerName: string, failure: ProviderFailure): void {
    const health = this.healthStatus.get(providerName);
    if (!health) return;

    const newFailures = health.consecutiveFailures + 1;
    const isHealthy = newFailures < this.maxConsecutiveFailures;

    this.lastFailures.set(providerName, failure);
    this.healthStatus.set(providerName, {
      isHealthy,
      consecutiveFailures: newFailures,
      lastFailure: new Date(),
      lastSuccess: health.lastSuccess,
      lastError: `${failure.code}: ${failure.message}`,
    });

    if (!isHealthy) {
      debugService.debug('[ProviderRouter] Provider marked unhealthy: {unhealthy} (failures: {failures})', {
        unhealthy: providerName,
        failures: newFailures,
      });
    }
  }

  /**
   * Report a success for a provider
   */
  reportSuccess(providerName: string): void {
    const health = this.healthStatus.get(providerName);

    this.healthStatus.set(providerName, {
      isHealthy: true,
      consecutiveFailures: 0,
      lastSuccess: new Date(),
      lastFailure: health?.lastFailure,
    });
  }

  /**
   * Run `operation` on one provider after another until one succeeds. Only an outage
   * (`RateLimited`, `ProviderFailed`, `ProviderUnauthorized`) moves on to the next provider and
   * counts against the provider's health. `Cancelled`, `UnexpectedDefect` (an unknown throw from
   * `operation`) and a refused, cut-off or unusable answer are returned at once. When every
   * provider failed or is tripped, returns `AllProvidersFailed` with each provider's failure code.
   */
  async executeWithFallback<T>(
    operation: (provider: LLMProvider) => Promise<T | ProviderFailure>,
  ): Promise<ProviderResult<T> | ProviderRouterFailure> {
    const startTime = Date.now();
    const attempts: ProviderAttempt[] = [];

    for (const provider of this.attemptOrder()) {
      debugService.debug('[ProviderRouter] Attempting operation with provider: {provider}', {
        provider: provider.name,
      });

      let result: T | ProviderFailure;
      try {
        result = await operation(provider);
      } catch (error) {
        result = providerFailure(error, { provider: provider.name, model: provider.model });
      }

      if (!isProviderFailure(result)) {
        this.reportSuccess(provider.name);
        return { data: result, provider: provider.name, durationMs: Date.now() - startTime };
      }

      debugService.debug('[ProviderRouter] Provider {providerName} failed: {code}', {
        providerName: provider.name,
        code: result.code,
      });
      if (!isOutage(result)) return result;
      this.recordOutage(provider.name, result);
      attempts.push({ provider: provider.name, failure: result });
    }

    return this.allFailed(attempts);
  }

  /**
   * Stream from one provider after another. A provider is replaced only when it fails with an
   * outage BEFORE its first chunk; after the first chunk its failure is final (the stream ends with
   * it), so the caller never reads the same text twice. Like `executeWithFallback`, `Cancelled`,
   * `UnexpectedDefect` and refusals end the stream at once, and the last item is
   * `AllProvidersFailed` when every provider failed or is tripped.
   */
  async *streamWithFallback(
    operation: (provider: LLMProvider) => AsyncGenerator<string | ProviderFailure, void, unknown>,
  ): AsyncGenerator<string | ProviderRouterFailure, void, unknown> {
    const attempts: ProviderAttempt[] = [];

    for (const provider of this.attemptOrder()) {
      debugService.debug('[ProviderRouter] Attempting stream with provider: {provider}', { provider: provider.name });

      let started = false;
      let failure: ProviderFailure | undefined;
      try {
        for await (const chunk of operation(provider)) {
          if (typeof chunk !== 'string') {
            failure = chunk;
            break;
          }
          started = true;
          yield chunk;
        }
      } catch (error) {
        failure = providerFailure(error, { provider: provider.name, model: provider.model });
      }

      if (!failure) {
        this.reportSuccess(provider.name);
        return;
      }

      debugService.debug('[ProviderRouter] Provider {providerName} stream failed: {code} (after text: {started})', {
        providerName: provider.name,
        code: failure.code,
        started,
      });
      const outage = isOutage(failure);
      if (outage) this.recordOutage(provider.name, failure);
      if (started || !outage) {
        yield failure;
        return;
      }
      attempts.push({ provider: provider.name, failure });
    }

    yield this.allFailed(attempts);
  }

  /**
   * Convenience method: Generate text with automatic failover
   */
  async generateText(prompt: string, options?: GenerateOptions): Promise<ProviderResult<string> | ProviderRouterFailure> {
    return this.executeWithFallback(provider => provider.generateText(prompt, options));
  }

  /**
   * Convenience method: Generate conversation with automatic failover
   */
  async generateConversation(
    messages: Message[],
    options?: GenerateOptions,
  ): Promise<ProviderResult<string> | ProviderRouterFailure> {
    return this.executeWithFallback(provider => provider.generateConversation(messages, options));
  }

  /**
   * Convenience method: Stream text with automatic failover
   */
  async *streamText(
    prompt: string,
    options: ProviderRouterStreamOptions = {},
  ): AsyncGenerator<string | ProviderRouterFailure, void, unknown> {
    const { onError, ...providerOptions } = options;
    yield* withFinalError(
      this.streamWithFallback(provider => provider.streamText(prompt, providerOptions)),
      onError,
    );
  }

  /**
   * Convenience method: Stream conversation with automatic failover
   */
  async *streamConversation(
    messages: Message[],
    options: ProviderRouterStreamOptions = {},
  ): AsyncGenerator<string | ProviderRouterFailure, void, unknown> {
    const { onError, ...providerOptions } = options;
    yield* withFinalError(
      this.streamWithFallback(provider => provider.streamConversation(messages, providerOptions)),
      onError,
    );
  }

  /**
   * Get current health status of all providers
   */
  getHealthStatus(): Map<string, ProviderHealth> {
    return new Map(this.healthStatus);
  }

  /**
   * Get list of available provider names
   */
  getAvailableProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get list of healthy provider names
   */
  getHealthyProviderNames(): string[] {
    return [...this.healthStatus.entries()].filter(([, health]) => health.isHealthy).map(([name]) => name);
  }

  /**
   * Reset health status for a specific provider
   */
  resetProviderHealth(providerName: string): void {
    if (this.providers.has(providerName)) {
      this.healthStatus.set(providerName, {
        isHealthy: true,
        consecutiveFailures: 0,
      });
      this.lastFailures.delete(providerName);
      debugService.debug('[ProviderRouter] Reset health for provider: {provider}', { provider: providerName });
    }
  }

  /**
   * Reset health status for all providers
   */
  resetAllHealth(): void {
    for (const name of this.providers.keys()) {
      this.resetProviderHealth(name);
    }
  }

  /**
   * Resolve the next healthy provider as an AI SDK LanguageModel.
   *
   * This bridges the ProviderRouter's health-aware selection with the
   * Vercel AI SDK's `streamText()` / `generateText()` functions, which
   * require a `LanguageModel` instance.
   *
   * @returns The resolved model and provider name for health reporting, or `AllProvidersFailed`
   *   when every provider is tripped (with the failure that tripped each)
   *
   * @example
   * ```ts
   * const router = createProviderRouter({ providers: [...] });
   * if (isFailure(router)) throw router; // NoProviderConfigured: a boot-time configuration fault
   * const resolved = router.toLanguageModel();
   * if (isFailure(resolved)) return resolved;
   *
   * const result = streamText({
   *   model: resolved.model,
   *   messages,
   *   onEnd: () => router.reportSuccess(resolved.providerName),
   *   onError: ({ error }) => router.reportFailure(resolved.providerName, error),
   * });
   * ```
   */
  toLanguageModel(): ResolvedLanguageModel | AllProvidersFailed {
    const healthyConfigs = this.getHealthyConfigs();
    const recovered = healthyConfigs.length === 0 ? this.tryRecoverProvider() : null;
    const config = recovered
      ? this.configs.find(c => c.name === recovered.name)
      : this.selectNextWeightedConfig(healthyConfigs);

    if (!config) return this.allFailed([]);

    const model = createLanguageModel(config);

    debugService.debug('[ProviderRouter] Resolved AI SDK model: {model} ({model2})', {
      model: config.name,
      model2: config.model,
    });

    return { model, providerName: config.name };
  }
}

/** Pass a router stream through, calling `onError` with the failure that ends it (the last item). */
async function* withFinalError(
  stream: AsyncGenerator<string | ProviderRouterFailure, void, unknown>,
  onError: ((failure: ProviderRouterFailure) => void) | undefined,
): AsyncGenerator<string | ProviderRouterFailure, void, unknown> {
  for await (const chunk of stream) {
    if (typeof chunk !== 'string') onError?.(chunk);
    yield chunk;
  }
}

/**
 * Build a ProviderRouter, or return `NoProviderConfigured` when no listed provider is enabled
 * with an API key. Check the result at boot.
 */
export function createProviderRouter(config: ProviderRouterConfig): ProviderRouter | NoProviderConfigured {
  return ProviderRouter.create(config);
}

/**
 * Create a ProviderRouter with default free-tier providers
 *
 * Automatically enables providers that have API keys configured. Returns `NoProviderConfigured`
 * when none of them has a key.
 */
export function createDefaultProviderRouter(options?: {
  defaultTemperature?: number;
}): ProviderRouter | NoProviderConfigured {
  return ProviderRouter.create({
    providers: [
      { name: 'groq', model: 'gemma2-9b-it', weight: 3, enabled: true },
      { name: 'google', model: 'gemini-1.5-flash', weight: 2, enabled: true },
      { name: 'mistral', model: 'mistral-small-latest', weight: 2, enabled: true },
      {
        name: 'openrouter',
        model: 'meta-llama/llama-3.2-3b-instruct:free',
        weight: 1,
        enabled: true,
      },
    ],
    defaultTemperature: options?.defaultTemperature ?? 0.7,
  });
}
