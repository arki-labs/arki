/**
 * Generic Anthropic Service using Vercel AI SDK
 * Provides helper methods for structured data generation
 */

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject, generateText } from 'ai';
import type { CoreMessage } from 'ai';
import { z } from '@arki/contracts';

import { GenerationError, getErrorMessage } from '../errors';
import { validateInput, aiServiceConfigSchema } from '../validation';
import { rateLimiters } from '../utils/rate-limiter';

export interface AnthropicServiceConfig {
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
  }

  /**
   * Generate structured data from message payloads (supports multimodal content)
   */
  async generateStructuredDataFromMessages<T>(
    messages: CoreMessage[],
    schema: z.ZodSchema<T>,
    options: { temperature?: number; maxRetries?: number; systemPrompt?: string } = {},
  ): Promise<T> {
    const result = await rateLimiters.anthropic.execute('generateStructuredDataFromMessages', async () => {
      try {
        const response = await generateObject({
          model: anthropic(this.model),
          system: options.systemPrompt,
          messages,
          schema: schema as any,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          temperature: options.temperature ?? this.defaultTemperature,
        });

        return response.object as T;
      } catch (error) {
        throw new GenerationError(`Failed to generate structured data: ${getErrorMessage(error)}`, error);
      }
    });

    if (!result.success) {
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
    try {
      const result = await generateText({
        model: anthropic(this.model),
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
      });

      return result.text;
    } catch (error) {
      throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
    }
  }
}
