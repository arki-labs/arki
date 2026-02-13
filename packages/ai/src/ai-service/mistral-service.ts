/**
 * Mistral AI LLM Service using Vercel AI SDK
 *
 * Uses Mistral's API for their suite of models.
 * Free tier: 1 billion tokens/month, various rate limits by model
 */

import { mistral } from '@ai-sdk/mistral';
import { generateText, streamText } from 'ai';

import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { GenerationError, getErrorMessage } from '../errors.ts';
import { rateLimiters } from '../utils/rate-limiter.ts';

import type {
  GenerateOptions,
  LLMProvider,
  Message,
  StreamOptions,
} from './types.ts';

export type MistralServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}

/**
 * Mistral AI LLM Service
 *
 * Uses Mistral's API for their suite of models.
 * Recommended models:
 * - mistral-small-latest (fast, efficient)
 * - mistral-medium-latest (balanced)
 * - mistral-large-latest (highest quality)
 * - open-mistral-7b (open source)
 * - open-mixtral-8x7b (open source, MoE)
 */
export class MistralService implements LLMProvider {
  readonly name = 'mistral';
  readonly model: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxRetries: number;

  constructor(config: MistralServiceConfig = {}) {
    this.model = config.model ?? 'mistral-small-latest';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxRetries = config.maxRetries ?? 2;

    debugService(
      '[Mistral] Service initialized (model: %s, temperature: %d)',
      this.model,
      this.defaultTemperature,
    );
  }

  /**
   * Check if Mistral is available (has API key configured)
   */
  isAvailable(): boolean {
    return !!env.MISTRAL_API_KEY;
  }

  /**
   * Generate text from a single prompt
   */
  async generateText(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService('[Mistral] Generating text (prompt length: %d)', prompt.length);

    const rateLimitResult = await rateLimiters.mistral.execute(
      'generateText',
      async () => {
        try {
          const result = await generateText({
            model: mistral(this.model),
            system: options.systemPrompt,
            prompt,
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Mistral] Text generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService('[Mistral] Text generation failed: %s', getErrorMessage(error));
          throw new GenerationError(
            `Failed to generate text: ${getErrorMessage(error)}`,
            error,
          );
        }
      },
    );

    if (!rateLimitResult.success) {
      throw new GenerationError(
        `Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`,
        rateLimitResult.error,
      );
    }

    return rateLimitResult.data!;
  }

  /**
   * Generate text from conversation messages
   */
  async generateConversation(
    messages: Message[],
    options: GenerateOptions = {},
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService('[Mistral] Generating conversation (messages: %d)', messages.length);

    const rateLimitResult = await rateLimiters.mistral.execute(
      'generateConversation',
      async () => {
        try {
          const result = await generateText({
            model: mistral(this.model),
            messages: messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Mistral] Conversation generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService(
            '[Mistral] Conversation generation failed: %s',
            getErrorMessage(error),
          );
          throw new GenerationError(
            `Failed to generate conversation: ${getErrorMessage(error)}`,
            error,
          );
        }
      },
    );

    if (!rateLimitResult.success) {
      throw new GenerationError(
        `Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`,
        rateLimitResult.error,
      );
    }

    return rateLimitResult.data!;
  }

  /**
   * Stream text generation from a prompt
   */
  async *streamText(
    prompt: string,
    options: StreamOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService('[Mistral] Streaming text (prompt length: %d)', prompt.length);

    try {
      const stream = await streamText({
        model: mistral(this.model),
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
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

      debugService('[Mistral] Stream completed (total length: %d)', fullText.length);
    } catch (error) {
      debugService('[Mistral] Stream failed: %s', getErrorMessage(error));
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(
        `Failed to stream text: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Stream conversation generation
   */
  async *streamConversation(
    messages: Message[],
    options: StreamOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService('[Mistral] Streaming conversation (messages: %d)', messages.length);

    try {
      const stream = await streamText({
        model: mistral(this.model),
        messages: messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
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

      debugService(
        '[Mistral] Conversation stream completed (total length: %d)',
        fullText.length,
      );
    } catch (error) {
      debugService('[Mistral] Conversation stream failed: %s', getErrorMessage(error));
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(
        `Failed to stream conversation: ${getErrorMessage(error)}`,
        error,
      );
    }
  }
}

/**
 * Factory function for creating Mistral service instances
 */
export function createMistralService(config?: MistralServiceConfig): MistralService {
  return new MistralService(config);
}
