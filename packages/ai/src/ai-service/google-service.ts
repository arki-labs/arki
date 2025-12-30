/**
 * Google AI (Gemini) LLM Service using Vercel AI SDK
 *
 * Uses Google's Generative AI API for Gemini models.
 * Free tier: 60 requests/minute, 1 million tokens/month
 */

import { google } from '@ai-sdk/google';
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

export interface GoogleServiceConfig {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}

/**
 * Google AI (Gemini) LLM Service
 *
 * Uses Google's Generative AI API for Gemini models.
 * Recommended models:
 * - gemini-1.5-flash (free tier, fast)
 * - gemini-1.5-pro (free tier, higher quality)
 * - gemini-2.0-flash-exp (experimental)
 */
export class GoogleService implements LLMProvider {
  readonly name = 'google';
  readonly model: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxRetries: number;

  constructor(config: GoogleServiceConfig = {}) {
    this.model = config.model ?? 'gemini-1.5-flash';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxRetries = config.maxRetries ?? 2;

    debugService(
      '[Google] Service initialized (model: %s, temperature: %d)',
      this.model,
      this.defaultTemperature,
    );
  }

  /**
   * Check if Google AI is available (has API key configured)
   */
  isAvailable(): boolean {
    return !!env.GOOGLE_GENERATIVE_AI_API_KEY;
  }

  /**
   * Generate text from a single prompt
   */
  async generateText(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Google Generative AI API key not configured');
    }

    debugService('[Google] Generating text (prompt length: %d)', prompt.length);

    const rateLimitResult = await rateLimiters.google.execute(
      'generateText',
      async () => {
        try {
          const result = await generateText({
            model: google(this.model),
            system: options.systemPrompt,
            prompt,
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Google] Text generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService('[Google] Text generation failed: %s', getErrorMessage(error));
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
      throw new GenerationError('Google Generative AI API key not configured');
    }

    debugService('[Google] Generating conversation (messages: %d)', messages.length);

    const rateLimitResult = await rateLimiters.google.execute(
      'generateConversation',
      async () => {
        try {
          const result = await generateText({
            model: google(this.model),
            messages: messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Google] Conversation generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService(
            '[Google] Conversation generation failed: %s',
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
      throw new GenerationError('Google Generative AI API key not configured');
    }

    debugService('[Google] Streaming text (prompt length: %d)', prompt.length);

    try {
      const stream = await streamText({
        model: google(this.model),
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

      debugService('[Google] Stream completed (total length: %d)', fullText.length);
    } catch (error) {
      debugService('[Google] Stream failed: %s', getErrorMessage(error));
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
      throw new GenerationError('Google Generative AI API key not configured');
    }

    debugService('[Google] Streaming conversation (messages: %d)', messages.length);

    try {
      const stream = await streamText({
        model: google(this.model),
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
        '[Google] Conversation stream completed (total length: %d)',
        fullText.length,
      );
    } catch (error) {
      debugService('[Google] Conversation stream failed: %s', getErrorMessage(error));
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
 * Factory function for creating Google service instances
 */
export function createGoogleService(config?: GoogleServiceConfig): GoogleService {
  return new GoogleService(config);
}
