/**
 * Groq LLM Service using Vercel AI SDK
 *
 * Groq provides an OpenAI-compatible API with fast inference on open models.
 * Free tier: 14,400 requests/day, 240 requests/minute
 */

import { createGroq } from '@ai-sdk/groq';
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

export type GroqServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}

/**
 * Groq LLM Service
 *
 * Uses Groq's OpenAI-compatible API for fast inference on open models.
 * Recommended models:
 * - gemma2-9b-it (free tier)
 * - llama-3.1-8b-instant (free tier)
 * - mixtral-8x7b-32768 (free tier)
 */
export class GroqService implements LLMProvider {
  readonly name = 'groq';
  readonly model: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxRetries: number;
  private readonly client: ReturnType<typeof createGroq>;

  constructor(config: GroqServiceConfig = {}) {
    this.model = config.model ?? 'gemma2-9b-it';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxRetries = config.maxRetries ?? 2;

    // Create Groq client using the dedicated @ai-sdk/groq package
    this.client = createGroq({
      apiKey: env.GROQ_API_KEY ?? '',
    });

    debugService(
      '[Groq] Service initialized (model: %s, temperature: %d)',
      this.model,
      this.defaultTemperature,
    );
  }

  /**
   * Check if Groq is available (has API key configured)
   */
  isAvailable(): boolean {
    return !!env.GROQ_API_KEY;
  }

  /**
   * Generate text from a single prompt
   */
  async generateText(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Groq API key not configured');
    }

    debugService('[Groq] Generating text (prompt length: %d)', prompt.length);

    const rateLimitResult = await rateLimiters.groq.execute(
      'generateText',
      async () => {
        try {
          const result = await generateText({
            model: this.client(this.model),
            system: options.systemPrompt,
            prompt,
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Groq] Text generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService('[Groq] Text generation failed: %s', getErrorMessage(error));
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService('[Groq] Generating conversation (messages: %d)', messages.length);

    const rateLimitResult = await rateLimiters.groq.execute(
      'generateConversation',
      async () => {
        try {
          const result = await generateText({
            model: this.client(this.model),
            messages: messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
            temperature: options.temperature ?? this.defaultTemperature,
            maxOutputTokens: options.maxTokens,
            maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          });

          debugService(
            '[Groq] Conversation generated successfully (length: %d)',
            result.text.length,
          );

          return result.text;
        } catch (error) {
          debugService(
            '[Groq] Conversation generation failed: %s',
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService('[Groq] Streaming text (prompt length: %d)', prompt.length);

    try {
      const stream = await streamText({
        model: this.client(this.model),
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

      debugService('[Groq] Stream completed (total length: %d)', fullText.length);
    } catch (error) {
      debugService('[Groq] Stream failed: %s', getErrorMessage(error));
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService('[Groq] Streaming conversation (messages: %d)', messages.length);

    // Map messages to the format expected by the API
    const mappedMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Log the full request for debugging
    console.log('[Groq] Request details:', {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      maxTokens: options.maxTokens,
      messagesCount: mappedMessages.length,
      messages: mappedMessages.map((m, i) => ({
        index: i,
        role: m.role,
        contentType: typeof m.content,
        contentLength: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
        contentPreview: typeof m.content === 'string'
          ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '')
          : JSON.stringify(m.content).slice(0, 200),
        // Check for any unexpected properties
        originalMessageKeys: Object.keys(messages[i] ?? {}),
      })),
    });

    try {
      const stream = await streamText({
        model: this.client(this.model),
        messages: mappedMessages,
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
        '[Groq] Conversation stream completed (total length: %d)',
        fullText.length,
      );
    } catch (error) {
      debugService('[Groq] Conversation stream failed: %s', getErrorMessage(error));
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
 * Factory function for creating Groq service instances
 */
export function createGroqService(config?: GroqServiceConfig): GroqService {
  return new GroqService(config);
}
