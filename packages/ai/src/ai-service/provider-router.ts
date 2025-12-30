/**
 * Provider Router for LLM Services
 *
 * Implements weighted round-robin rotation and automatic failover
 * between multiple LLM providers.
 */

import { debugService } from '../debug.ts';
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

/**
 * Configuration for the ProviderRouter
 */
export interface ProviderRouterConfig {
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
  private readonly providers: Map<string, LLMProvider> = new Map();
  private readonly configs: ProviderConfig[];
  private readonly healthStatus: Map<string, ProviderHealth> = new Map();
  private readonly maxConsecutiveFailures: number;
  private readonly healthCheckIntervalMs: number;
  private currentIndex = 0;
  private totalWeight = 0;

  constructor(config: ProviderRouterConfig) {
    this.configs = config.providers.filter((p) => p.enabled !== false);
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 60000;

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
    const model = config.model ?? DEFAULT_MODELS[config.name];
    const temperature = defaultTemperature ?? 0.7;

    switch (config.name) {
      case 'groq':
        return createGroqService({ model, temperature });
      case 'google':
        return createGoogleService({ model, temperature });
      case 'mistral':
        return createMistralService({ model, temperature });
      case 'openrouter':
        return createOpenRouterService({ model, temperature });
      case 'openai':
      case 'anthropic':
        // These are supported but need to be added separately if needed
        debugService(
          '[ProviderRouter] Provider %s not yet implemented in router',
          config.name,
        );
        return null;
      default:
        debugService('[ProviderRouter] Unknown provider: %s', config.name);
        return null;
    }
  }

  /**
   * Get the next healthy provider using weighted round-robin
   */
  getNextProvider(): LLMProvider | null {
    const availableProviders = this.getHealthyProviders();

    if (availableProviders.length === 0) {
      // Try to recover an unhealthy provider
      const recoveredProvider = this.tryRecoverProvider();
      if (recoveredProvider) {
        return recoveredProvider;
      }
      return null;
    }

    // Weighted round-robin selection
    const configsWithProviders = this.configs.filter(
      (c) =>
        this.providers.has(c.name) &&
        this.healthStatus.get(c.name)?.isHealthy !== false,
    );

    if (configsWithProviders.length === 0) {
      return null;
    }

    // Simple round-robin for now (can be enhanced with weighted selection)
    const config = configsWithProviders[this.currentIndex % configsWithProviders.length];
    if (!config) {
      return null;
    }
    this.currentIndex = (this.currentIndex + 1) % configsWithProviders.length;

    const provider = this.providers.get(config.name);
    debugService('[ProviderRouter] Selected provider: %s', config.name);

    return provider ?? null;
  }

  /**
   * Get all healthy providers
   */
  private getHealthyProviders(): LLMProvider[] {
    const healthy: LLMProvider[] = [];

    for (const [name, provider] of this.providers) {
      const health = this.healthStatus.get(name);
      if (health?.isHealthy !== false) {
        healthy.push(provider);
      }
    }

    return healthy;
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
          new Error(`Tried providers: ${Array.from(triedProviders).join(', ')}`),
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
      new Error(`Tried providers: ${Array.from(triedProviders).join(', ')}`),
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
          new Error(`Tried providers: ${Array.from(triedProviders).join(', ')}`),
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
      new Error(`Tried providers: ${Array.from(triedProviders).join(', ')}`),
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
    return Array.from(this.providers.keys());
  }

  /**
   * Get list of healthy provider names
   */
  getHealthyProviderNames(): string[] {
    return Array.from(this.healthStatus.entries())
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
