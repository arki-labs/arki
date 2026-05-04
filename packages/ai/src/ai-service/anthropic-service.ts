/**
 * Generic Anthropic Service using Vercel AI SDK
 * Provides helper methods for structured data generation
 */

import { anthropic } from '@ai-sdk/anthropic';
import { Output, generateText } from 'ai';
import type { ModelMessage, SystemModelMessage } from 'ai';
import type { z } from '@arki/contracts';

type ChatMessage = ModelMessage;

import { debugService } from '../debug.ts';
import { GenerationError, RateLimitError, getErrorMessage } from '../errors';
import { validateInput, aiServiceConfigSchema } from '../validation';
import { rateLimiters } from '../utils/rate-limiter';

/**
 * A system prompt part that can optionally be cached via Anthropic's prompt caching.
 * When `cacheControl` is set, the content is marked for caching at Anthropic's edge,
 * reducing cost by ~90% on cache hits (5-minute TTL).
 */
export type SystemPart = {
  text: string;
  cacheControl?: { type: 'ephemeral' };
};

export type AnthropicServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}

/**
 * Converts a system prompt (string or SystemPart[]) into the format expected by
 * the Vercel AI SDK. When parts have `cacheControl`, they are passed via
 * `providerOptions.anthropic.cacheControl` for Anthropic's prompt caching.
 */
function buildSystemParam(
  systemPrompt: string | SystemPart[] | undefined,
): string | SystemModelMessage[] | undefined {
  if (!systemPrompt) return undefined;
  if (typeof systemPrompt === 'string') return systemPrompt;

  return systemPrompt.map((part): SystemModelMessage => ({
    role: 'system',
    content: part.text,
    providerOptions: part.cacheControl
      ? { anthropic: { cacheControl: part.cacheControl } }
      : undefined,
  }));
}

export class AnthropicService {
  private model: string;
  private defaultTemperature: number;
  private defaultMaxRetries: number;

  constructor(config: AnthropicServiceConfig = {}) {
    const validConfig = validateInput(aiServiceConfigSchema, {
      provider: 'anthropic',
      ...config,
    });

    this.model = validConfig.model || 'claude-3-5-sonnet-latest';
    this.defaultTemperature = validConfig.temperature ?? 0.2;
    this.defaultMaxRetries = validConfig.maxRetries ?? 2;

    debugService(
      '[Anthropic] Service initialized (model: %s, temperature: %d, maxRetries: %d)',
      this.model,
      this.defaultTemperature,
      this.defaultMaxRetries,
    );
  }

  /**
   * Generate structured data from a single text prompt.
   *
   * Convenience wrapper over {@link generateStructuredDataFromMessages} that
   * mirrors the API surface of `OpenAIService.generateStructuredData`, so
   * both services are interchangeable for callers that only need
   * single-prompt structured generation.
   */
  async generateStructuredData<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: {
      temperature?: number;
      maxRetries?: number;
      systemPrompt?: string | SystemPart[];
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    return this.generateStructuredDataFromMessages(
      [{ role: 'user', content: prompt }],
      schema,
      options,
    );
  }

  /**
   * Generate structured data from message payloads (supports multimodal content)
   */
  async generateStructuredDataFromMessages<T>(
    messages: ChatMessage[],
    schema: z.ZodSchema<T>,
    options: {
      temperature?: number;
      maxRetries?: number;
      systemPrompt?: string | SystemPart[];
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    debugService(
      '[Anthropic] Generating structured data (messages: %d, temperature: %d)',
      messages.length,
      options.temperature ?? this.defaultTemperature,
    );

    const system = buildSystemParam(options.systemPrompt);

    const result = await rateLimiters.anthropic.execute('generateStructuredDataFromMessages', async () => {
      try {
        debugService('[Anthropic] Calling Anthropic API for structured generation');

        const response = await generateText({
          model: anthropic(this.model),
          system,
          messages,
          output: Output.object({ schema: schema as z.ZodSchema }),
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          temperature: options.temperature ?? this.defaultTemperature,
          abortSignal: options.signal,
        });

        debugService(
          '[Anthropic] Structured data generated successfully (cache: creation=%d, read=%d)',
          (response.providerMetadata?.anthropic as Record<string, number> | undefined)?.cacheCreationInputTokens ?? 0,
          (response.providerMetadata?.anthropic as Record<string, number> | undefined)?.cacheReadInputTokens ?? 0,
        );

        return response.output as T;
      } catch (error) {
        debugService('[Anthropic] Structured generation failed: %s', getErrorMessage(error));

        throw new GenerationError(`Failed to generate structured data: ${getErrorMessage(error)}`, error);
      }
    });

    if (!result.success) {
      debugService('[Anthropic] Rate limit exceeded (retry after: %dms)', result.retryAfterMs);

      throw new RateLimitError(
        `Anthropic rate limit exceeded: retry after ${result.retryAfterMs}ms`,
        result.retryAfterMs,
      );
    }

    return result.data;
  }

  /**
   * Generate plain text (helper for future use cases)
   */
  async generateText(
    prompt: string,
    options: {
      temperature?: number;
      maxRetries?: number;
      systemPrompt?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    debugService('[Anthropic] Generating text (prompt length: %d)', prompt.length);

    try {
      const result = await generateText({
        model: anthropic(this.model),
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
      });

      debugService('[Anthropic] Text generated successfully (length: %d)', result.text.length);

      return result.text;
    } catch (error) {
      debugService('[Anthropic] Text generation failed: %s', getErrorMessage(error));

      throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
    }
  }
}
