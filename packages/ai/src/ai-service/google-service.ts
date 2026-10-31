/**
 * Google AI (Gemini) LLM Service using Vercel AI SDK
 *
 * Uses Google's Generative AI API for Gemini models.
 * Free tier: 60 requests/minute, 1 million tokens/month
 */

import { google } from '@ai-sdk/google';
import type { TextStreamPart, ToolSet } from 'ai';
import { generateText, streamText } from 'ai';

import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures.ts';
import type { GenerateOptions, LLMProvider, Message, StreamOptions } from './types.ts';
import { debugService } from '../debug.ts';
import { env } from '../env.ts';
import { ProviderUnauthorized, RateLimited } from '../failures.ts';
import { rateLimiters } from '../utils/rate-limiter.ts';
import { finishFailure, providerFailure, readTextParts } from './provider-failure.ts';
import { aiTelemetry } from './telemetry.ts';

export type GoogleServiceConfig = {
  model?: string;
  temperature?: number;
  maxRetries?: number;
};

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

    debugService.debug('[Google] Service initialized (model: {model}, temperature: {temperature})', {
      model: this.model,
      temperature: this.defaultTemperature,
    });
  }

  /**
   * Check if Google AI is available (has API key configured)
   */
  isAvailable(): boolean {
    return !!env.GOOGLE_GENERATIVE_AI_API_KEY;
  }

  /**
   * Generate text from a single prompt. A missing API key, a full rate limiter, a provider error
   * and a cut-off answer are returned as a `ProviderFailure`, never thrown.
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const missing = this.missingKey();
    if (missing) return missing;

    debugService.debug('[Google] Generating text (prompt length: {length})', { length: prompt.length });

    return rateLimiters.google.execute('generateText', async () => {
      try {
        const result = await generateText({
          model: google(this.model),
          instructions: options.systemPrompt,
          prompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('google.generateText'),
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

    debugService.debug('[Google] Generating conversation (messages: {messages})', { messages: messages.length });

    return rateLimiters.google.execute('generateConversation', async () => {
      try {
        const result = await generateText({
          model: google(this.model),
          messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
          temperature: options.temperature ?? this.defaultTemperature,
          maxOutputTokens: options.maxTokens,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('google.generateConversation'),
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
    debugService.debug('[Google] Streaming text (prompt length: {length})', { length: prompt.length });

    yield* this.stream('streamText', options, () =>
      streamText({
        model: google(this.model),
        instructions: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('google.streamText'),
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
    debugService.debug('[Google] Streaming conversation (messages: {messages})', { messages: messages.length });

    yield* this.stream('streamConversation', options, () =>
      streamText({
        model: google(this.model),
        messages: messages.map(msg => ({ role: msg.role, content: msg.content })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxOutputTokens: options.maxTokens,
        abortSignal: options.signal,
        ...aiTelemetry('google.streamConversation'),
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
    debugService.debug('[Google] {operation} failed: {code}', { operation, code: failure.code });
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
    debugService.debug('[Google] {operation} completed (total length: {length})', { operation, length: fullText.length });
  }

  /** Take a slot from the same rate limiter `generateText` uses; `RateLimited` when none is free. */
  private async rateLimitSlot(operation: string): Promise<RateLimited | undefined> {
    const slot = await rateLimiters.google.execute(operation, () => Promise.resolve());
    return RateLimited.is(slot) ? slot : undefined;
  }
}

/**
 * Factory function for creating Google service instances
 */
export function createGoogleService(config?: GoogleServiceConfig): GoogleService {
  return new GoogleService(config);
}
