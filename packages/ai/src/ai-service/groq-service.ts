/**
 * Groq LLM Service using Vercel AI SDK
 *
 * Groq provides an OpenAI-compatible API with fast inference on open models.
 * Free tier: 14,400 requests/day, 240 requests/minute
 */

import { createGroq } from '@ai-sdk/groq';
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
   * Generate text from a single prompt. A missing API key, a full rate limiter, a provider error
   * and a cut-off answer are returned as a `ProviderFailure`, never thrown.
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const missing = this.missingKey();
    if (missing) return missing;

    debugService.debug('[Groq] Generating text (prompt length: {length})', { length: prompt.length });

    return rateLimiters.groq.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('groq.generateText'),
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

    debugService.debug('[Groq] Generating conversation (messages: {messages})', { messages: messages.length });

    return rateLimiters.groq.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: this.client(this.model),
          messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('groq.generateConversation'),
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
    debugService.debug('[Groq] Streaming text (prompt length: {length})', { length: prompt.length });

    yield* this.stream('streamText', options, () =>
      streamText({
        model: this.client(this.model),
        instructions: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('groq.streamText'),
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
    debugService.debug('[Groq] Streaming conversation (messages: {messages})', { messages: messages.length });

    yield* this.stream('streamConversation', options, () =>
      streamText({
        model: this.client(this.model),
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('groq.streamConversation'),
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
    debugService.debug('[Groq] {operation} failed: {code}', { operation, code: failure.code });
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
    debugService.debug('[Groq] {operation} completed (total length: {length})', { operation, length: fullText.length });
  }

  /** Take a slot from the same rate limiter `generateText` uses; `RateLimited` when none is free. */
  private async rateLimitSlot(operation: string): Promise<RateLimited | undefined> {
    const slot = await rateLimiters.groq.execute(operation, () => Promise.resolve());
    return RateLimited.is(slot) ? slot : undefined;
  }
}

/**
 * Factory function for creating Groq service instances
 */
export function createGroqService(config?: GroqServiceConfig): GroqService {
  return new GroqService(config);
}
