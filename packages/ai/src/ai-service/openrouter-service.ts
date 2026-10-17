/**
 * OpenRouter LLM Service using Vercel AI SDK
 *
 * OpenRouter is an API aggregator that provides access to many LLM models
 * through a unified OpenAI-compatible API. Includes many free models.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';

import type { GenerateOptions, LLMProvider, Message, StreamOptions } from './types.ts';
import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { GenerationError, getErrorMessage } from '../errors.ts';
import type { RateLimited } from '../failures.ts';
import { rateLimiters } from '../utils/rate-limiter.ts';

export type OpenRouterServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
  /** Site URL for OpenRouter attribution (optional) */
  siteUrl?: string;
  /** Site name for OpenRouter attribution (optional) */
  siteName?: string;
};

/**
 * OpenRouter LLM Service
 *
 * Provides access to many models through OpenRouter's aggregated API.
 * Free models available:
 * - meta-llama/llama-3.2-3b-instruct:free
 * - meta-llama/llama-3.1-8b-instruct:free
 * - google/gemma-2-9b-it:free
 * - microsoft/phi-3-mini-128k-instruct:free
 * - qwen/qwen-2-7b-instruct:free
 */
export class OpenRouterService implements LLMProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxRetries: number;
  private readonly client: ReturnType<typeof createOpenAI>;

  constructor(config: OpenRouterServiceConfig = {}) {
    this.model = config.model ?? 'meta-llama/llama-3.2-3b-instruct:free';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxRetries = config.maxRetries ?? 2;

    // Create OpenAI-compatible client with OpenRouter base URL
    this.client = createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY ?? '',
      headers: {
        // Optional: OpenRouter attribution headers
        ...(config.siteUrl && { 'HTTP-Referer': config.siteUrl }),
        ...(config.siteName && { 'X-Title': config.siteName }),
      },
    });

    debugService.debug('[OpenRouter] Service initialized (model: {model}, temperature: {temperature})', {
      model: this.model,
      temperature: this.defaultTemperature,
    });
  }

  /**
   * Check if OpenRouter is available (has API key configured)
   */
  isAvailable(): boolean {
    return !!env.OPENROUTER_API_KEY;
  }

  /**
   * Generate text from a single prompt
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | RateLimited> {
    if (!this.isAvailable()) {
      throw new GenerationError('OpenRouter API key not configured');
    }

    debugService.debug('[OpenRouter] Generating text (prompt length: {length})', { length: prompt.length });

    const rateLimitResult = await rateLimiters.openrouter.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        });

        debugService.debug('[OpenRouter] Text generated successfully (length: {length})', {
          length: result.text.length,
        });

        return result.text;
      } catch (error) {
        debugService.debug('[OpenRouter] Text generation failed: {failed}', { failed: getErrorMessage(error) });
        throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
      }
    });

    return rateLimitResult;
  }

  /**
   * Generate text from conversation messages
   */
  async generateConversation(messages: Message[], options: GenerateOptions = {}): Promise<string | RateLimited> {
    if (!this.isAvailable()) {
      throw new GenerationError('OpenRouter API key not configured');
    }

    debugService.debug('[OpenRouter] Generating conversation (messages: {messages})', { messages: messages.length });

    const rateLimitResult = await rateLimiters.openrouter.execute('generateConversation', async () => {
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

        debugService.debug('[OpenRouter] Conversation generated successfully (length: {length})', {
          length: result.text.length,
        });

        return result.text;
      } catch (error) {
        debugService.debug('[OpenRouter] Conversation generation failed: {failed}', { failed: getErrorMessage(error) });
        throw new GenerationError(`Failed to generate conversation: ${getErrorMessage(error)}`, error);
      }
    });

    return rateLimitResult;
  }

  /**
   * Stream text generation from a prompt
   */
  async *streamText(prompt: string, options: StreamOptions = {}): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new GenerationError('OpenRouter API key not configured');
    }

    debugService.debug('[OpenRouter] Streaming text (prompt length: {length})', { length: prompt.length });

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

      debugService.debug('[OpenRouter] Stream completed (total length: {length})', { length: fullText.length });
    } catch (error) {
      debugService.debug('[OpenRouter] Stream failed: {failed}', { failed: getErrorMessage(error) });
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
      throw new GenerationError('OpenRouter API key not configured');
    }

    debugService.debug('[OpenRouter] Streaming conversation (messages: {messages})', { messages: messages.length });

    try {
      const stream = await streamText({
        model: this.client(this.model),
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

      debugService.debug('[OpenRouter] Conversation stream completed (total length: {length})', {
        length: fullText.length,
      });
    } catch (error) {
      debugService.debug('[OpenRouter] Conversation stream failed: {failed}', { failed: getErrorMessage(error) });
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream conversation: ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Factory function for creating OpenRouter service instances
 */
export function createOpenRouterService(config?: OpenRouterServiceConfig): OpenRouterService {
  return new OpenRouterService(config);
}
