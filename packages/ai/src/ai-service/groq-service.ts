/**
 * Groq LLM Service using Vercel AI SDK
 *
 * Groq provides an OpenAI-compatible API with fast inference on open models.
 * Free tier: 14,400 requests/day, 240 requests/minute
 */

import { createGroq } from '@ai-sdk/groq';
import { generateText, streamText } from 'ai';

import type { GenerateOptions, LLMProvider, Message, StreamOptions } from './types.ts';
import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { GenerationError, getErrorMessage, RateLimitError } from '../errors.ts';
import { RateLimited } from '../failures.ts';
import { rateLimiters } from '../utils/rate-limiter.ts';

export type GroqServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
};

/**
 * Groq LLM Service
 *
 * Uses Groq's OpenAI-compatible API for fast inference on open models.
 * Recommended models (Groq retired the Llama 3.x fleet — verify against
 * https://api.groq.com/openai/v1/models before adding new ids):
 * - openai/gpt-oss-20b (fast, cheap default)
 * - openai/gpt-oss-120b (larger)
 * - qwen/qwen3.6-27b
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

    debugService.debug('[Groq] Service initialized (model: {model}, temperature: {temperature})', {
      model: this.model,
      temperature: this.defaultTemperature,
    });
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
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (!this.isAvailable()) {
      throw new GenerationError('Groq API key not configured');
    }

    debugService.debug('[Groq] Generating text (prompt length: {length})', { length: prompt.length });

    const rateLimitResult = await rateLimiters.groq.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        });

        debugService.debug('[Groq] Text generated successfully (length: {length})', { length: result.text.length });

        return result.text;
      } catch (error) {
        debugService.debug('[Groq] Text generation failed: {failed}', { failed: getErrorMessage(error) });
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService.debug('[Groq] Generating conversation (messages: {messages})', { messages: messages.length });

    const rateLimitResult = await rateLimiters.groq.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        });

        debugService.debug('[Groq] Conversation generated successfully (length: {length})', {
          length: result.text.length,
        });

        return result.text;
      } catch (error) {
        debugService.debug('[Groq] Conversation generation failed: {failed}', { failed: getErrorMessage(error) });
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService.debug('[Groq] Streaming text (prompt length: {length})', { length: prompt.length });

    try {
      const stream = await streamText({
        model: this.client(this.model),
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

      debugService.debug('[Groq] Stream completed (total length: {length})', { length: fullText.length });
    } catch (error) {
      debugService.debug('[Groq] Stream failed: {failed}', { failed: getErrorMessage(error) });
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
      throw new GenerationError('Groq API key not configured');
    }

    debugService.debug('[Groq] Streaming conversation (messages: {messages})', { messages: messages.length });

    // Map messages to the format expected by the API
    const mappedMessages = messages.map(msg => ({
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
        contentPreview:
          typeof m.content === 'string'
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

      debugService.debug('[Groq] Conversation stream completed (total length: {length})', { length: fullText.length });
    } catch (error) {
      debugService.debug('[Groq] Conversation stream failed: {failed}', { failed: getErrorMessage(error) });
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream conversation: ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Factory function for creating Groq service instances
 */
export function createGroqService(config?: GroqServiceConfig): GroqService {
  return new GroqService(config);
}
