/**
 * Generic OpenAI Service using Vercel AI SDK
 * Provides reusable AI generation capabilities with built-in
 * rate limiting and optional input sanitization.
 */

import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import { generateText, Output, streamText } from 'ai';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { z } from '@arki/contracts';
import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import type { AIServiceConfig as OpenAIServiceConfig, GenerationOptions as ValidatedGenerationOptions } from '../validation';
import { debugService } from '../debug.ts';
import { InputBlocked, RateLimited } from '../failures';
import { modelSchema } from './model-schema';
import { finishFailure, providerFailure, readTextParts } from './provider-failure';
import { aiTelemetry } from './telemetry';
import { BaseInputSanitizer } from '../safety/input-sanitizer';
import { rateLimiters } from '../utils/rate-limiter';
import { validateInput } from './validate-input';
import { aiServiceConfigSchema } from '../validation-schemas';

type ChatMessage = ModelMessage;

export type { AIServiceConfig as OpenAIServiceConfig } from '../validation';

export type GenerationOptions = ValidatedGenerationOptions & {
  /**
   * Forwarded as `abortSignal` to the AI SDK so the upstream HTTP
   * call is cancelled when the signal aborts. Required for cockatiel
   * timeouts to actually stop work upstream.
   */
  signal?: AbortSignal;
};

export type OpenAIStreamOptions = {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onComplete?: (text: string) => void;
  /** Called with the failure that ends the stream, just before the stream yields it. */
  onError?: (failure: ProviderFailure) => void;
} & GenerationOptions;

/**
 * Generic OpenAI Service for various AI tasks.
 *
 * All API-calling methods are rate-limited (60 RPM for OpenAI).
 * Input sanitization (prompt injection detection, PII redaction) is opt-in
 * via the `sanitize` constructor option.
 */
export class OpenAIService {
  readonly name = 'openai';
  private model: string;
  private defaultTemperature: number;
  private defaultMaxRetries: number;
  private sanitizer: BaseInputSanitizer | null;

  constructor(config: OpenAIServiceConfig = {}) {
    const validConfig = validateInput(aiServiceConfigSchema, config);
    this.model = validConfig.model || 'gpt-4o-mini';
    this.defaultTemperature = validConfig.temperature ?? 0.7;
    this.defaultMaxRetries = validConfig.maxRetries ?? 2;

    // Initialize sanitizer if enabled
    if (validConfig.sanitize) {
      const sanitizerConfig = typeof validConfig.sanitize === 'object' ? validConfig.sanitize : undefined;
      this.sanitizer = new BaseInputSanitizer(sanitizerConfig);
      debugService.debug('[OpenAI] Input sanitization enabled');
    } else {
      this.sanitizer = null;
    }

    debugService.debug(
      '[OpenAI] Service initialized (model: {model}, temperature: {temperature}, maxRetries: {maxRetries}, sanitize: {sanitize})',
      {
        model: this.model,
        temperature: this.defaultTemperature,
        maxRetries: this.defaultMaxRetries,
        sanitize: !!this.sanitizer,
      },
    );
  }

  /**
   * Generate structured data from a prompt. A blocked input is `InputBlocked`; every way the
   * provider call can fail (rate limit, refusal, cut-off, outage, cancel) is a returned `ProviderFailure`.
   */
  async generateStructuredData<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options: GenerationOptions = {},
  ): Promise<SchemaOutput<S> | ProviderFailure | InputBlocked> {
    return this.generateStructuredDataFromMessages([{ role: 'user', content: prompt }], schema, options);
  }

  /**
   * Generate structured data using explicit message payloads.
   * Supports multimodal content (e.g., including images).
   */
  async generateStructuredDataFromMessages<S extends StandardSchemaV1>(
    messages: ChatMessage[],
    schema: S,
    options: GenerationOptions = {},
  ): Promise<SchemaOutput<S> | ProviderFailure | InputBlocked> {
    const sanitizedMessages = this.sanitizeMessages(messages);
    if (InputBlocked.is(sanitizedMessages)) return sanitizedMessages;

    debugService.debug('[OpenAI] Generating structured data (messages: {messages}, temperature: {temperature})', {
      messages: sanitizedMessages.length,
      temperature: options.temperature ?? this.defaultTemperature,
    });

    return this.withRateLimit('generateStructuredData', async () => {
      try {
        debugService.debug('[OpenAI] Calling OpenAI API for structured generation');

        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          messages: sanitizedMessages,
          output: Output.object({ schema: modelSchema(schema, 'OpenAI structured generation') }),
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          temperature: options.temperature ?? this.defaultTemperature,
          abortSignal: options.signal,
          ...aiTelemetry('openai.generateStructuredData'),
        });
        return finishFailure(result.finishReason, this.call(options)) ?? result.output;
      } catch (error) {
        return providerFailure(error, this.call(options));
      }
    });
  }

  /**
   * Generate text completion.
   */
  async generateText(prompt: string, options: GenerationOptions = {}): Promise<string | ProviderFailure | InputBlocked> {
    const sanitizedPrompt = this.sanitizeInput(prompt);
    if (InputBlocked.is(sanitizedPrompt)) return sanitizedPrompt;

    debugService.debug('[OpenAI] Generating text (prompt length: {length})', { length: sanitizedPrompt.length });

    return this.withRateLimit('generateText', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          prompt: sanitizedPrompt,
          temperature: options.temperature ?? this.defaultTemperature,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('openai.generateText'),
        });
        return finishFailure(result.finishReason, this.call(options)) ?? result.text;
      } catch (error) {
        return providerFailure(error, this.call(options));
      }
    });
  }

  /**
   * Generate text with conversation context.
   */
  async generateConversation(
    messages: ChatMessage[],
    options: GenerationOptions = {},
  ): Promise<string | ProviderFailure | InputBlocked> {
    const sanitizedMessages = this.sanitizeMessages(messages);
    if (InputBlocked.is(sanitizedMessages)) return sanitizedMessages;

    return this.withRateLimit('generateConversation', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          messages: sanitizedMessages,
          temperature: options.temperature ?? this.defaultTemperature,
          maxRetries: options.maxRetries ?? this.defaultMaxRetries,
          abortSignal: options.signal,
          ...aiTelemetry('openai.generateConversation'),
        });
        return finishFailure(result.finishReason, this.call(options)) ?? result.text;
      } catch (error) {
        return providerFailure(error, this.call(options));
      }
    });
  }

  /**
   * Stream text generation. Takes a rate-limit slot before the stream starts, so an over-limit
   * caller gets `RateLimited` (and a blocked input `InputBlocked`) up front; otherwise resolves to
   * a generator of text chunks whose last item is the `ProviderFailure` when the stream fails or stops early.
   */
  async streamText(
    prompt: string,
    options: OpenAIStreamOptions = {},
  ): Promise<AsyncGenerator<string | ProviderFailure, void, unknown> | RateLimited | InputBlocked> {
    const sanitizedPrompt = this.sanitizeInput(prompt);
    if (InputBlocked.is(sanitizedPrompt)) return sanitizedPrompt;

    // Register rate limit slot before starting the stream
    const slot = await this.consumeRateLimitSlot('streamText');
    if (RateLimited.is(slot)) return slot;

    return this.streamTextChunks(sanitizedPrompt, options);
  }

  private streamTextChunks(
    sanitizedPrompt: string,
    options: OpenAIStreamOptions,
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    return this.streamChunks('streamText', options, () =>
      streamText({
        model: openai(this.model),
        instructions: options.systemPrompt,
        prompt: sanitizedPrompt,
        temperature: options.temperature ?? this.defaultTemperature,
        abortSignal: options.signal,
        ...aiTelemetry('openai.streamText'),
      }).fullStream,
    );
  }

  /**
   * Stream conversation with context. Fails like {@link streamText}.
   */
  async streamConversation(
    messages: ChatMessage[],
    options: OpenAIStreamOptions = {},
  ): Promise<AsyncGenerator<string | ProviderFailure, void, unknown> | RateLimited | InputBlocked> {
    const sanitizedMessages = this.sanitizeMessages(messages);
    if (InputBlocked.is(sanitizedMessages)) return sanitizedMessages;

    // Register rate limit slot before starting the stream
    const slot = await this.consumeRateLimitSlot('streamConversation');
    if (RateLimited.is(slot)) return slot;

    return this.streamConversationChunks(sanitizedMessages, options);
  }

  private streamConversationChunks(
    sanitizedMessages: ChatMessage[],
    options: OpenAIStreamOptions,
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    return this.streamChunks('streamConversation', options, () =>
      streamText({
        model: openai(this.model),
        instructions: options.systemPrompt,
        messages: sanitizedMessages,
        temperature: options.temperature ?? this.defaultTemperature,
        abortSignal: options.signal,
        ...aiTelemetry('openai.streamConversation'),
      }).fullStream,
    );
  }

  /**
   * Create a raw AI SDK text stream (useful for tRPC streaming endpoints). The caller reads it and
   * owns its errors: read `fullStream` through `readTextParts` to get failures as values.
   */
  createTextStream(prompt: string, systemPrompt?: string): ReturnType<typeof streamText> | InputBlocked {
    const sanitizedPrompt = this.sanitizeInput(prompt);
    if (InputBlocked.is(sanitizedPrompt)) return sanitizedPrompt;

    return streamText({
      model: openai(this.model),
      instructions: systemPrompt,
      prompt: sanitizedPrompt,
      temperature: this.defaultTemperature,
      ...aiTelemetry('openai.createTextStream'),
    });
  }

  /**
   * Batch process multiple prompts. Each slot holds the answer or that prompt's failure
   * (`ProviderFailure` or `InputBlocked`); use `partition` from `@arki/failure` to split them.
   */
  async batchGenerate<S extends StandardSchemaV1>(
    prompts: string[],
    schema?: S,
    options: GenerationOptions = {},
  ): Promise<(SchemaOutput<S> | string | ProviderFailure | InputBlocked)[]> {
    debugService.debug('[OpenAI] Batch generating {promptsLength} prompts (structured: {structured})', {
      promptsLength: prompts.length,
      structured: !!schema,
    });

    const results = await Promise.all(
      prompts.map(prompt =>
        schema ? this.generateStructuredData(prompt, schema, options) : this.generateText(prompt, options),
      ),
    );

    debugService.debug('[OpenAI] Batch generation complete ({successCount}/{promptsLength} successful)', {
      successCount: results.filter((result: unknown) => !isFailure(result)).length,
      promptsLength: prompts.length,
    });

    return results;
  }

  /**
   * Check if content is appropriate/safe.
   * Note: Input sanitization is intentionally skipped here since the
   * purpose is to analyze raw text for safety.
   */
  async moderateContent(text: string): Promise<
    | {
        safe: boolean;
        categories?: string[];
        confidence?: number;
      }
    | ProviderFailure
  > {
    const moderationSchema = z.object({
      safe: z.boolean(),
      categories: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    });

    const prompt = `Analyze the following content for safety and appropriateness.
Identify any problematic categories if present.

Content: "${text}"`;

    // Bypass sanitization for moderation — we need to analyze raw text
    return this.withRateLimit('moderateContent', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          instructions: 'You are a content moderation assistant. Analyze text for safety.',
          messages: [{ role: 'user', content: prompt }],
          output: Output.object({ schema: moderationSchema }),
          maxRetries: this.defaultMaxRetries,
          temperature: 0.1,
          ...aiTelemetry('openai.moderateContent'),
        });
        return finishFailure(result.finishReason, this.call({})) ?? result.output;
      } catch (error) {
        return providerFailure(error, this.call({}));
      }
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** The names and signal of one call, for the failure boundary. */
  private call(options: { signal?: AbortSignal | undefined }) {
    return { provider: this.name, model: this.model, signal: options.signal };
  }

  /**
   * Wraps an async function with rate limiting. A refused call returns `RateLimited` and never runs
   * `fn`; any failure is logged at DEBUG and returned.
   */
  private async withRateLimit<T>(key: string, fn: () => Promise<T>): Promise<T | RateLimited> {
    const result = await rateLimiters.openai.execute(key, fn);
    const value: unknown = result;
    if (isFailure(value)) debugService.debug('[OpenAI] {key} failed: {code}', { key, code: value.code });
    return result;
  }

  /**
   * The text of one stream, with the lifecycle callbacks. A throw while starting the stream, an
   * `error` part, an abort or a finish other than `stop` ends it with one `ProviderFailure`, which
   * `onError` sees first.
   */
  private async *streamChunks(
    operation: string,
    options: OpenAIStreamOptions,
    start: () => AsyncIterable<TextStreamPart<ToolSet>>,
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    const call = this.call(options);
    options.onStart?.();

    let chunks: AsyncIterable<string | ProviderFailure> | readonly ProviderFailure[];
    try {
      chunks = readTextParts(start(), call);
    } catch (error) {
      chunks = [providerFailure(error, call)];
    }

    let fullText = '';
    for await (const chunk of chunks) {
      if (isFailure(chunk)) {
        debugService.debug('[OpenAI] {operation} failed: {code}', { operation, code: chunk.code });
        options.onError?.(chunk);
        yield chunk;
        return;
      }
      fullText += chunk;
      options.onToken?.(chunk);
      yield chunk;
    }
    options.onComplete?.(fullText);
  }

  /**
   * Consumes a rate limit slot without wrapping a function.
   * Used for streaming methods where the rate limit check must happen
   * before the generator starts yielding.
   */
  private async consumeRateLimitSlot(key: string): Promise<RateLimited | undefined> {
    const slot = await this.withRateLimit(key, () => Promise.resolve());
    return RateLimited.is(slot) ? slot : undefined;
  }

  /**
   * Sanitizes a single text input if sanitization is enabled.
   * Returns the original text unchanged when sanitization is disabled, and `InputBlocked` when the
   * sanitizer refuses it (e.g., prompt injection detected).
   */
  private sanitizeInput(text: string): string | InputBlocked {
    if (!this.sanitizer) {
      return text;
    }

    const report = this.sanitizer.sanitize(text);

    if (report.result === 'blocked') {
      debugService.debug('[OpenAI] Input blocked by sanitizer: {sanitizer}', { sanitizer: report.blockedReason });
      return InputBlocked({ reason: report.blockedReason ?? 'blocked by the input sanitizer' });
    }

    if (report.result === 'sanitized' && report.sanitizedInput) {
      debugService.debug('[OpenAI] Input sanitized ({issuesFoundLength} issues found)', {
        issuesFoundLength: report.issuesFound.length,
      });
      return report.sanitizedInput;
    }

    return text;
  }

  /**
   * Sanitizes all user-role messages in a conversation.
   * System and assistant messages are trusted and passed through unchanged.
   * Returns `InputBlocked` when any user message is blocked.
   */
  private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] | InputBlocked {
    if (!this.sanitizer) {
      return messages;
    }

    const sanitized: ChatMessage[] = [];
    for (const msg of messages) {
      // Only sanitize plain-string user content — other roles and multimodal content pass through
      if (msg.role !== 'user' || typeof msg.content !== 'string') {
        sanitized.push(msg);
        continue;
      }
      const content = this.sanitizeInput(msg.content);
      if (InputBlocked.is(content)) return content;
      sanitized.push({ role: 'user', content });
    }
    return sanitized;
  }
}
