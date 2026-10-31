/**
 * OpenRouter LLM Service using Vercel AI SDK
 *
 * OpenRouter is an API aggregator that provides access to many LLM models
 * through a unified OpenAI-compatible API. Includes many free models.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { TextStreamPart, ToolSet } from 'ai';
import { generateText, streamText } from 'ai';

import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures.js';
import type { GenerateOptions, LLMProvider, Message, StreamOptions } from './types.js';
import { debugService } from '../debug.js';
import { env } from '../env.js';
import { ProviderUnauthorized, RateLimited } from '../failures.js';
import { rateLimiters } from '../utils/rate-limiter.js';
import { finishFailure, providerFailure, readTextParts } from './provider-failure.js';
import { aiTelemetry } from './telemetry.js';

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
   * Generate text from a single prompt. A missing API key, a full rate limiter, a provider error
   * and a cut-off answer are returned as a `ProviderFailure`, never thrown.
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const missing = this.missingKey();
    if (missing) return missing;

    debugService.debug('[OpenRouter] Generating text (prompt length: {length})', { length: prompt.length });

    return rateLimiters.openrouter.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('openrouter.generateText'),
        });
        return finishFailure(result.finishReason, this.call(options)) ?? result.text;
      } catch (error) {
        return this.failed('generateText', providerFailure(error, this.call(options)));
      }
    });
  }

  /**
   * Generate text from conversation messages. Fails like {@link generateText}.
   */
  async generateConversation(messages: Message[], options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const missing = this.missingKey();
    if (missing) return missing;

    debugService.debug('[OpenRouter] Generating conversation (messages: {messages})', { messages: messages.length });

    return rateLimiters.openrouter.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('openrouter.generateConversation'),
        });
        return finishFailure(result.finishReason, this.call(options)) ?? result.text;
      } catch (error) {
        return this.failed('generateConversation', providerFailure(error, this.call(options)));
      }
    });
  }

  /**
   * Stream text generation from a prompt. Takes a rate-limit slot first; when the stream fails or
   * stops early, its last item is the `ProviderFailure`.
   */
  async *streamText(prompt: string, options: StreamOptions = {}): AsyncGenerator<string | ProviderFailure, void, unknown> {
    debugService.debug('[OpenRouter] Streaming text (prompt length: {length})', { length: prompt.length });

    yield* this.stream('streamText', options, () =>
      streamText({
        model: this.client(this.model),
        instructions: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('openrouter.streamText'),
      }).fullStream,
    );
  }

  /**
   * Stream conversation generation. Fails like {@link streamText}.
   */
  async *streamConversation(
    messages: Message[],
    options: StreamOptions = {},
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    debugService.debug('[OpenRouter] Streaming conversation (messages: {messages})', { messages: messages.length });

    yield* this.stream('streamConversation', options, () =>
      streamText({
        model: this.client(this.model),
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('openrouter.streamConversation'),
      }).fullStream,
    );
  }

  /** The names and signal of one call, for the failure boundary. */
  private call(options: GenerateOptions) {
    return { provider: this.name, model: this.model, signal: options.signal };
  }

  /** `ProviderUnauthorized` when no API key is set, so no request is sent. */
  private missingKey(): ProviderUnauthorized | undefined {
    return this.isAvailable() ? undefined : ProviderUnauthorized({ provider: this.name, model: this.model });
  }

  /** Log a failed call at DEBUG and hand the failure back. */
  private failed<F extends ProviderFailure>(operation: string, failure: F): F {
    debugService.debug('[OpenRouter] {operation} failed: {code}', { operation, code: failure.code });
    return failure;
  }

  /**
   * Run one stream: a missing key or a full rate limiter ends it before any request is sent;
   * otherwise it yields the text of `start()`'s parts. Either way a failure is the last item, and
   * `onError` sees it first.
   */
  private async *stream(
    operation: 'streamText' | 'streamConversation',
    options: StreamOptions,
    start: () => AsyncIterable<TextStreamPart<ToolSet>>,
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    const call = this.call(options);
    let chunks: AsyncIterable<string | ProviderFailure> | readonly ProviderFailure[];
    const refused = this.missingKey() ?? (await this.rateLimitSlot(operation));
    if (refused) {
      chunks = [refused];
    } else {
      try {
        chunks = readTextParts(start(), call);
      } catch (error) {
        chunks = [providerFailure(error, call)];
      }
    }

    let fullText = '';
    for await (const chunk of chunks) {
      if (isFailure(chunk)) {
        const failure = this.failed(operation, chunk);
        options.onError?.(failure);
        yield failure;
        return;
      }
      fullText += chunk;
      options.onChunk?.(chunk);
      yield chunk;
    }
    options.onComplete?.(fullText);
    debugService.debug('[OpenRouter] {operation} completed (total length: {length})', { operation, length: fullText.length });
  }

  /** Take a slot from the same rate limiter `generateText` uses; `RateLimited` when none is free. */
  private async rateLimitSlot(operation: string): Promise<RateLimited | undefined> {
    const slot = await rateLimiters.openrouter.execute(operation, () => Promise.resolve());
    return RateLimited.is(slot) ? slot : undefined;
  }
}

/**
 * Factory function for creating OpenRouter service instances
 */
export function createOpenRouterService(config?: OpenRouterServiceConfig): OpenRouterService {
  return new OpenRouterService(config);
}
