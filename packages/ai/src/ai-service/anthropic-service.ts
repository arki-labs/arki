/**
 * Generic Anthropic Service using Vercel AI SDK
 * Provides helper methods for structured data generation
 */

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject, generateText } from 'ai';
import type { z } from '@arki/contracts';

type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

import { debugService } from '../debug.ts';
import { GenerationError, getErrorMessage } from '../errors';
import { validateInput, aiServiceConfigSchema } from '../validation';
import { rateLimiters } from '../utils/rate-limiter';

export type AnthropicServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
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
   * Generate structured data from message payloads (supports multimodal content)
   */
  async generateStructuredDataFromMessages<T>(
    messages: ChatMessage[],
    schema: z.ZodSchema<T>,
    options: { temperature?: number; maxRetries?: number; systemPrompt?: string } = {},
  ): Promise<T> {
    debugService(
      '[Anthropic] Generating structured data (messages: %d, temperature: %d)',
      messages.length,
      options.temperature ?? this.defaultTemperature,
    );

    const result = await rateLimiters.anthropic.execute('generateStructuredDataFromMessages', async () => {
      try {
        debugService('[Anthropic] Calling Anthropic API for structured generation');

        const response = await generateObject({
          model: anthropic(this.model),
          system: options.systemPrompt,
          messages,
          schema: schema as any,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          temperature: options.temperature ?? this.defaultTemperature,
        });

        debugService('[Anthropic] Structured data generated successfully');

        return response.object as T;
      } catch (error) {
        debugService('[Anthropic] Structured generation failed: %s', getErrorMessage(error));

        throw new GenerationError(`Failed to generate structured data: ${getErrorMessage(error)}`, error);
      }
    });

    if (!result.success) {
      debugService('[Anthropic] Rate limit exceeded (retry after: %dms)', result.retryAfterMs);

      throw new GenerationError(
        `Anthropic rate limit exceeded: retry after ${result.retryAfterMs ?? 0}ms`,
        result.error,
      );
    }

    return result.data!;
  }

  /**
   * Generate plain text (helper for future use cases)
   */
  async generateText(prompt: string, options: { temperature?: number; maxRetries?: number; systemPrompt?: string } = {}) {
    debugService('[Anthropic] Generating text (prompt length: %d)', prompt.length);

    try {
      const result = await generateText({
        model: anthropic(this.model),
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
      });

      debugService('[Anthropic] Text generated successfully (length: %d)', result.text.length);

      return result.text;
    } catch (error) {
      debugService('[Anthropic] Text generation failed: %s', getErrorMessage(error));

      throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
    }
  }
}
