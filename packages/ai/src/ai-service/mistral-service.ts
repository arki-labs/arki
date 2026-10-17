/**
 * Mistral AI LLM Service using Vercel AI SDK
 *
 * Uses Mistral's API for their suite of models.
 * Free tier: 1 billion tokens/month, various rate limits by model
 */

import { mistral } from '@ai-sdk/mistral';
import { generateText, streamText } from 'ai';

import type { GenerateOptions, LLMProvider, Message, StreamOptions } from './types.ts';
import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { GenerationError, getErrorMessage, RateLimitError } from '../errors.ts';
import { RateLimited } from '../failures.ts';
import { rateLimiters } from '../utils/rate-limiter.ts';

export type MistralServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
};

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

    debugService.debug('[Mistral] Service initialized (model: {model}, temperature: {temperature})', {
      model: this.model,
      temperature: this.defaultTemperature,
    });
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
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService.debug('[Mistral] Generating text (prompt length: {length})', { length: prompt.length });

    const rateLimitResult = await rateLimiters.mistral.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: mistral(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        });

        debugService.debug('[Mistral] Text generated successfully (length: {length})', { length: result.text.length });

        return result.text;
      } catch (error) {
        debugService.debug('[Mistral] Text generation failed: {failed}', { failed: getErrorMessage(error) });
        throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
      }
    });

    if (RateLimited.is(rateLimitResult)) {
      throw new RateLimitError(
        `Rate limit exceeded: retry after ${rateLimitResult.data.retryAfterMs}ms`,
        rateLimitResult.data.retryAfterMs,
      );
    }

    return rateLimitResult;
  }

  /**
   * Generate text from conversation messages
   */
  async generateConversation(messages: Message[], options: GenerateOptions = {}): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService.debug('[Mistral] Generating conversation (messages: {messages})', { messages: messages.length });

    const rateLimitResult = await rateLimiters.mistral.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: mistral(this.model),
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        });

        debugService.debug('[Mistral] Conversation generated successfully (length: {length})', {
          length: result.text.length,
        });

        return result.text;
      } catch (error) {
        debugService.debug('[Mistral] Conversation generation failed: {failed}', { failed: getErrorMessage(error) });
        throw new GenerationError(`Failed to generate conversation: ${getErrorMessage(error)}`, error);
      }
    });

    if (RateLimited.is(rateLimitResult)) {
      throw new RateLimitError(
        `Rate limit exceeded: retry after ${rateLimitResult.data.retryAfterMs}ms`,
        rateLimitResult.data.retryAfterMs,
      );
    }

    return rateLimitResult;
  }

  /**
   * Stream text generation from a prompt
   */
  async *streamText(prompt: string, options: StreamOptions = {}): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService.debug('[Mistral] Streaming text (prompt length: {length})', { length: prompt.length });

    try {
      const stream = await streamText({
        model: mistral(this.model),
        instructions: options.systemPrompt,
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

      debugService.debug('[Mistral] Stream completed (total length: {length})', { length: fullText.length });
    } catch (error) {
      debugService.debug('[Mistral] Stream failed: {failed}', { failed: getErrorMessage(error) });
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream text: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * Stream conversation generation
   */
  async *streamConversation(messages: Message[], options: StreamOptions = {}): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new GenerationError('Mistral API key not configured');
    }

    debugService.debug('[Mistral] Streaming conversation (messages: {messages})', { messages: messages.length });

    try {
      const stream = await streamText({
        model: mistral(this.model),
        messages: messages.map(msg => ({
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

      debugService.debug('[Mistral] Conversation stream completed (total length: {length})', {
        length: fullText.length,
      });
    } catch (error) {
      debugService.debug('[Mistral] Conversation stream failed: {failed}', { failed: getErrorMessage(error) });
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream conversation: ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Factory function for creating Mistral service instances
 */
export function createMistralService(config?: MistralServiceConfig): MistralService {
  return new MistralService(config);
}
