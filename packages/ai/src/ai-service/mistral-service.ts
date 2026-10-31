/**
 * Mistral AI LLM Service using Vercel AI SDK
 *
 * Uses Mistral's API for their suite of models.
 * Free tier: 1 billion tokens/month, various rate limits by model
 */

import { mistral } from '@ai-sdk/mistral';
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
   * Generate text from a single prompt. A missing API key, a full rate limiter, a provider error
   * and a cut-off answer are returned as a `ProviderFailure`, never thrown.
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const missing = this.missingKey();
    if (missing) return missing;

    debugService.debug('[Mistral] Generating text (prompt length: {length})', { length: prompt.length });

    return rateLimiters.mistral.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: mistral(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('mistral.generateText'),
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

    debugService.debug('[Mistral] Generating conversation (messages: {messages})', { messages: messages.length });

    return rateLimiters.mistral.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: mistral(this.model),
          messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('mistral.generateConversation'),
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
    debugService.debug('[Mistral] Streaming text (prompt length: {length})', { length: prompt.length });

    yield* this.stream('streamText', options, () =>
      streamText({
        model: mistral(this.model),
        instructions: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('mistral.streamText'),
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
    debugService.debug('[Mistral] Streaming conversation (messages: {messages})', { messages: messages.length });

    yield* this.stream('streamConversation', options, () =>
      streamText({
        model: mistral(this.model),
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('mistral.streamConversation'),
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
    debugService.debug('[Mistral] {operation} failed: {code}', { operation, code: failure.code });
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
    debugService.debug('[Mistral] {operation} completed (total length: {length})', { operation, length: fullText.length });
  }

  /** Take a slot from the same rate limiter `generateText` uses; `RateLimited` when none is free. */
  private async rateLimitSlot(operation: string): Promise<RateLimited | undefined> {
    const slot = await rateLimiters.mistral.execute(operation, () => Promise.resolve());
    return RateLimited.is(slot) ? slot : undefined;
  }
}

/**
 * Factory function for creating Mistral service instances
 */
export function createMistralService(config?: MistralServiceConfig): MistralService {
  return new MistralService(config);
}
