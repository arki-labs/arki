/**
 * Provider Router for LLM Services
 *
 * Implements weighted round-robin rotation and automatic failover
 * between multiple LLM providers.
 */

import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral, mistral } from '@ai-sdk/mistral';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';

import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { GenerationError, getErrorMessage } from '../errors.ts';

import { createGoogleService } from './google-service.ts';
import { createGroqService } from './groq-service.ts';
import { createMistralService } from './mistral-service.ts';
import { createOpenRouterService } from './openrouter-service.ts';
import type {
  GenerateOptions,
  LLMProvider,
  Message,
  ProviderConfig,
  ProviderHealth,
  ProviderResult,
  StreamOptions,
} from './types.ts';

/**
 * Default models for each provider (free tier compatible)
 */
const DEFAULT_MODELS: Record<ProviderConfig['name'], string> = {
  groq: 'gemma2-9b-it',
  google: 'gemini-1.5-flash',
  mistral: 'mistral-small-latest',
  openrouter: 'meta-llama/llama-3.2-3b-instruct:free',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
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

function createLanguageModelProvider(
  config: ProviderConfig,
  defaultTemperature: number,
): LLMProvider {
  const model = resolveModel(config);
  const maxRetries = 2;

  return {
    name: config.name,
    model,
    isAvailable: () => hasConfiguredCredentials(config),
    generateText: async (prompt, options = {}) => {
      if (!hasConfiguredCredentials(config)) {
        throw new GenerationError(`${config.name} API key not configured`);
      }

      try {
        const result = await generateText({
          model: createLanguageModel(config),
          system: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? maxRetries,
          stopSequences: options.stopSequences,
        });

        return result.text;
      } catch (error) {
        throw new GenerationError(
          `Failed to generate text with ${config.name}: ${getErrorMessage(error)}`,
          error,
        );
      }
    },
    generateConversation: async (messages, options = {}) => {
      if (!hasConfiguredCredentials(config)) {
        throw new GenerationError(`${config.name} API key not configured`);
      }

      try {
        const result = await generateText({
          model: createLanguageModel(config),
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: options.temperature ?? defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? maxRetries,
          stopSequences: options.stopSequences,
        });

        return result.text;
      } catch (error) {
        throw new GenerationError(
          `Failed to generate conversation with ${config.name}: ${getErrorMessage(error)}`,
          error,
        );
      }
    },
    streamText: async function* (prompt, options = {}) {
      if (!hasConfiguredCredentials(config)) {
        throw new GenerationError(`${config.name} API key not configured`);
      }

      try {
        const stream = streamText({
          model: createLanguageModel(config),
          system: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? defaultTemperature,
          maxOutputTokens: options.maxTokens,
          stopSequences: options.stopSequences,
        });

        let fullText = '';
        for await (const chunk of stream.textStream) {
          fullText += chunk;
          if (options.onChunk) {
            options.onChunk(chunk);
          }
          yield chunk;
        }

        if (options.onComplete) {
          options.onComplete(fullText);
        }
      } catch (error) {
        if (options.onError) {
          options.onError(error as Error);
        }

        throw new GenerationError(
          `Failed to stream text with ${config.name}: ${getErrorMessage(error)}`,
          error,
        );
      }
    },
    streamConversation: async function* (messages, options = {}) {
      if (!hasConfiguredCredentials(config)) {
        throw new GenerationError(`${config.name} API key not configured`);
      }

      try {
        const stream = streamText({
          model: createLanguageModel(config),
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: options.temperature ?? defaultTemperature,
          maxOutputTokens: options.maxTokens,
          stopSequences: options.stopSequences,
        });

        let fullText = '';
        for await (const chunk of stream.textStream) {
          fullText += chunk;
          if (options.onChunk) {
            options.onChunk(chunk);
          }
          yield chunk;
        }

        if (options.onComplete) {
          options.onComplete(fullText);
        }
      } catch (error) {
        if (options.onError) {
          options.onError(error as Error);
        }

        throw new GenerationError(
          `Failed to stream conversation with ${config.name}: ${getErrorMessage(error)}`,
          error,
        );
      }
    },
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
}

/**
 * Provider Router
 *
 * Manages multiple LLM providers with:
 * - Weighted round-robin selection
 * - Automatic failover on errors
 * - Health tracking and recovery
 */
export class ProviderRouter {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly configs: ProviderConfig[];
  private readonly healthStatus = new Map<string, ProviderHealth>();
  private readonly maxConsecutiveFailures: number;
  private readonly healthCheckIntervalMs: number;
  private currentIndex = 0;
  private totalWeight = 0;

  constructor(config: ProviderRouterConfig) {
    this.configs = config.providers.filter((p) => p.enabled !== false);
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 60_000;

    // Initialize providers
    for (const providerConfig of this.configs) {
      const provider = this.createProvider(
        providerConfig,
        config.defaultTemperature,
      );

      if (provider && provider.isAvailable()) {
        this.providers.set(providerConfig.name, provider);
        this.healthStatus.set(providerConfig.name, {
          isHealthy: true,
          consecutiveFailures: 0,
        });
        this.totalWeight += providerConfig.weight ?? 1;

        debugService(
          '[ProviderRouter] Registered provider: %s (model: %s, weight: %d)',
          providerConfig.name,
          providerConfig.model,
          providerConfig.weight ?? 1,
        );
      } else {
        debugService(
          '[ProviderRouter] Skipping unavailable provider: %s',
          providerConfig.name,
        );
      }
    }

    if (this.providers.size === 0) {
      throw new GenerationError(
        'No LLM providers available. Please configure at least one provider API key.',
      );
    }

    debugService(
      '[ProviderRouter] Initialized with %d providers (total weight: %d)',
      this.providers.size,
      this.totalWeight,
    );
  }

  /**
   * Create a provider instance based on config
   */
  private createProvider(
    config: ProviderConfig,
    defaultTemperature?: number,
  ): LLMProvider | null {
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
      default: {
        return createLanguageModelProvider({ ...config, model }, temperature);
      }
    }
  }

  /**
   * Get all healthy provider configs that are currently available.
   */
  private getHealthyConfigs(): ProviderConfig[] {
    return this.configs.filter(
      (config) =>
        this.providers.has(config.name) &&
        this.healthStatus.get(config.name)?.isHealthy !== false,
    );
  }

  /**
   * Select the next config using weighted round-robin.
   */
  private selectNextWeightedConfig(configs: ProviderConfig[]): ProviderConfig | null {
    if (configs.length === 0) {
      return null;
    }

    const normalized = configs.map((config) => ({
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
    debugService('[ProviderRouter] Selected provider: %s', config.name);

    return provider ?? null;
  }

  /**
   * Try to recover an unhealthy provider after the health check interval
   */
  private tryRecoverProvider(): LLMProvider | null {
    const now = Date.now();

    for (const [name, health] of this.healthStatus) {
      if (
        !health.isHealthy &&
        health.lastFailure &&
        now - health.lastFailure.getTime() > this.healthCheckIntervalMs
      ) {
        debugService(
          '[ProviderRouter] Attempting to recover provider: %s',
          name,
        );

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
   * Report a failure for a provider
   */
  reportFailure(providerName: string, error: Error): void {
    const health = this.healthStatus.get(providerName);
    if (!health) return;

    const newFailures = health.consecutiveFailures + 1;
    const isHealthy = newFailures < this.maxConsecutiveFailures;

    this.healthStatus.set(providerName, {
      isHealthy,
      consecutiveFailures: newFailures,
      lastFailure: new Date(),
      lastSuccess: health.lastSuccess,
      lastError: error.message,
    });

    if (!isHealthy) {
      debugService(
        '[ProviderRouter] Provider marked unhealthy: %s (failures: %d)',
        providerName,
        newFailures,
      );
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
   * Execute an operation with automatic failover
   */
  async executeWithFallback<T>(
    operation: (provider: LLMProvider) => Promise<T>,
  ): Promise<ProviderResult<T>> {
    const startTime = Date.now();
    const triedProviders = new Set<string>();

    while (triedProviders.size < this.providers.size) {
      const provider = this.getNextProvider();

      if (!provider) {
        throw new GenerationError(
          'No healthy providers available',
          new Error(`Tried providers: ${[...triedProviders].join(', ')}`),
        );
      }

      if (triedProviders.has(provider.name)) {
        continue;
      }

      triedProviders.add(provider.name);

      try {
        debugService(
          '[ProviderRouter] Attempting operation with provider: %s',
          provider.name,
        );

        const data = await operation(provider);
        this.reportSuccess(provider.name);

        return {
          data,
          provider: provider.name,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        debugService(
          '[ProviderRouter] Provider %s failed: %s',
          provider.name,
          getErrorMessage(error),
        );

        this.reportFailure(provider.name, error as Error);
        // Continue to next provider
      }
    }

    throw new GenerationError(
      'All providers failed',
      new Error(`Tried providers: ${[...triedProviders].join(', ')}`),
    );
  }

  /**
   * Stream with automatic failover
   *
   * Note: Streaming with failover is tricky because we can't retry
   * mid-stream. This implementation fails over before starting the stream.
   */
  async *streamWithFallback(
    operation: (provider: LLMProvider) => AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    const triedProviders = new Set<string>();

    while (triedProviders.size < this.providers.size) {
      const provider = this.getNextProvider();

      if (!provider) {
        throw new GenerationError(
          'No healthy providers available',
          new Error(`Tried providers: ${[...triedProviders].join(', ')}`),
        );
      }

      if (triedProviders.has(provider.name)) {
        continue;
      }

      triedProviders.add(provider.name);

      try {
        debugService(
          '[ProviderRouter] Attempting stream with provider: %s',
          provider.name,
        );

        const stream = operation(provider);

        // Yield all chunks from the stream
        for await (const chunk of stream) {
          yield chunk;
        }

        // If we get here, stream completed successfully
        this.reportSuccess(provider.name);
        return;
      } catch (error) {
        debugService(
          '[ProviderRouter] Provider %s stream failed: %s',
          provider.name,
          getErrorMessage(error),
        );

        this.reportFailure(provider.name, error as Error);
        // Continue to next provider
      }
    }

    throw new GenerationError(
      'All providers failed',
      new Error(`Tried providers: ${[...triedProviders].join(', ')}`),
    );
  }

  /**
   * Convenience method: Generate text with automatic failover
   */
  async generateText(
    prompt: string,
    options?: GenerateOptions,
  ): Promise<ProviderResult<string>> {
    return this.executeWithFallback((provider) =>
      provider.generateText(prompt, options),
    );
  }

  /**
   * Convenience method: Generate conversation with automatic failover
   */
  async generateConversation(
    messages: Message[],
    options?: GenerateOptions,
  ): Promise<ProviderResult<string>> {
    return this.executeWithFallback((provider) =>
      provider.generateConversation(messages, options),
    );
  }

  /**
   * Convenience method: Stream text with automatic failover
   */
  async *streamText(
    prompt: string,
    options?: StreamOptions,
  ): AsyncGenerator<string, void, unknown> {
    yield* this.streamWithFallback((provider) =>
      provider.streamText(prompt, options),
    );
  }

  /**
   * Convenience method: Stream conversation with automatic failover
   */
  async *streamConversation(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<string, void, unknown> {
    yield* this.streamWithFallback((provider) =>
      provider.streamConversation(messages, options),
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
    return [...this.healthStatus.entries()]
      .filter(([, health]) => health.isHealthy)
      .map(([name]) => name);
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
      debugService('[ProviderRouter] Reset health for provider: %s', providerName);
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
   * @returns The resolved model and provider name for health reporting
   * @throws GenerationError if no healthy provider is available
   *
   * @example
   * ```ts
   * const router = createProviderRouter({ providers: [...] });
   * const { model, providerName } = router.toLanguageModel();
   *
   * const result = streamText({
   *   model,
   *   messages,
   *   onFinish: () => router.reportSuccess(providerName),
   *   onError: () => router.reportFailure(providerName, new Error('failed')),
   * });
   * ```
   */
  toLanguageModel(): ResolvedLanguageModel {
    const healthyConfigs = this.getHealthyConfigs();

    if (healthyConfigs.length === 0) {
      // Attempt recovery before giving up
      const recovered = this.tryRecoverProvider();
      if (recovered) {
        const config = this.configs.find((c) => c.name === recovered.name);
        if (config) {
          const model = createLanguageModel(config);
          debugService(
            '[ProviderRouter] Resolved recovered AI SDK model: %s (%s)',
            config.name,
            config.model,
          );
          return { model, providerName: config.name };
        }
      }

      throw new GenerationError(
        'No healthy LLM provider available. Configure at least one provider API key.',
      );
    }

    const config = this.selectNextWeightedConfig(healthyConfigs);
    if (!config) {
      throw new GenerationError('No healthy LLM provider available.');
    }

    const model = createLanguageModel(config);

    debugService(
      '[ProviderRouter] Resolved AI SDK model: %s (%s)',
      config.name,
      config.model,
    );

    return { model, providerName: config.name };
  }
}

/**
 * Factory function for creating a ProviderRouter
 */
export function createProviderRouter(
  config: ProviderRouterConfig,
): ProviderRouter {
  return new ProviderRouter(config);
}

/**
 * Create a ProviderRouter with default free-tier providers
 *
 * Automatically enables providers that have API keys configured.
 */
export function createDefaultProviderRouter(options?: {
  defaultTemperature?: number;
}): ProviderRouter {
  return new ProviderRouter({
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
