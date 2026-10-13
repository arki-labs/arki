/**
 * Generic OpenAI Service using Vercel AI SDK
 * Provides reusable AI generation capabilities with built-in
 * rate limiting and optional input sanitization.
 */

import type { ModelMessage } from 'ai';
import { openai } from '@ai-sdk/openai';
import { generateText, Output, streamText } from 'ai';

import { z } from '@arki/contracts';

import type { SanitizerConfig } from '../safety/types';
import { debugService } from '../debug.ts';
import { GenerationError, getErrorMessage, RateLimitError } from '../errors';
import { BaseInputSanitizer } from '../safety/input-sanitizer';
import { rateLimiters } from '../utils/rate-limiter';
import { aiServiceConfigSchema, validateInput } from '../validation';

type ChatMessage = ModelMessage;

export type OpenAIServiceConfig = {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
  /** Enable input sanitization. `true` uses defaults; pass config object for customization. */
  sanitize?: boolean | SanitizerConfig;
};

export type GenerationOptions = {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  systemPrompt?: string;
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
  onError?: (error: Error) => void;
} & GenerationOptions;

/**
 * Generic OpenAI Service for various AI tasks.
 *
 * All API-calling methods are rate-limited (60 RPM for OpenAI).
 * Input sanitization (prompt injection detection, PII redaction) is opt-in
 * via the `sanitize` constructor option.
 */
export class OpenAIService {
  private model: string;
  private defaultTemperature: number;
  private defaultMaxRetries: number;
  private sanitizer: BaseInputSanitizer | null;

  constructor(config: OpenAIServiceConfig = {}) {
    const validConfig = validateInput(aiServiceConfigSchema, config);
    this.model = validConfig.model || 'gpt-4o-mini';
    this.defaultTemperature = validConfig.temperature || 0.7;
    this.defaultMaxRetries = validConfig.maxRetries || 2;

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
   * Generate structured data from a prompt.
   */
  async generateStructuredData<T>(prompt: string, schema: z.ZodSchema<T>, options: GenerationOptions = {}): Promise<T> {
    return this.generateStructuredDataFromMessages([{ role: 'user', content: prompt }], schema, options);
  }

  /**
   * Generate structured data using explicit message payloads.
   * Supports multimodal content (e.g., including images).
   */
  async generateStructuredDataFromMessages<T>(
    messages: ChatMessage[],
    schema: z.ZodSchema<T>,
    options: GenerationOptions = {},
  ): Promise<T> {
    const sanitizedMessages = this.sanitizeMessages(messages);

    debugService.debug('[OpenAI] Generating structured data (messages: {messages}, temperature: {temperature})', {
      messages: sanitizedMessages.length,
      temperature: options.temperature || this.defaultTemperature,
    });

    return this.withRateLimit('generateStructuredData', async () => {
      try {
        debugService.debug('[OpenAI] Calling OpenAI API for structured generation');

        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          messages: sanitizedMessages,
          output: Output.object({ schema: schema as z.ZodSchema }),
          maxRetries: options.maxRetries || this.defaultMaxRetries,
          temperature: options.temperature || this.defaultTemperature,
          abortSignal: options.signal,
        });

        debugService.debug('[OpenAI] Structured data generated successfully');

        return result.output as T;
      } catch (error) {
        debugService.debug('[OpenAI] Structured generation failed: {failed}', { failed: getErrorMessage(error) });

        throw new GenerationError(`Failed to generate structured data: ${getErrorMessage(error)}`, error);
      }
    });
  }

  /**
   * Generate text completion.
   */
  async generateText(prompt: string, options: GenerationOptions = {}): Promise<string> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    debugService.debug('[OpenAI] Generating text (prompt length: {length})', { length: sanitizedPrompt.length });

    return this.withRateLimit('generateText', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          prompt: sanitizedPrompt,
          temperature: options.temperature || this.defaultTemperature,
          maxRetries: options.maxRetries || this.defaultMaxRetries,
          abortSignal: options.signal,
        });

        debugService.debug('[OpenAI] Text generated successfully (length: {length})', { length: result.text.length });

        return result.text;
      } catch (error) {
        debugService.debug('[OpenAI] Text generation failed: {failed}', { failed: getErrorMessage(error) });

        throw new GenerationError(`Failed to generate text: ${getErrorMessage(error)}`, error);
      }
    });
  }

  /**
   * Generate text with conversation context.
   */
  async generateConversation(messages: ChatMessage[], options: GenerationOptions = {}): Promise<string> {
    const sanitizedMessages = this.sanitizeMessages(messages);

    return this.withRateLimit('generateConversation', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          instructions: options.systemPrompt,
          messages: sanitizedMessages,
          temperature: options.temperature || this.defaultTemperature,
          maxRetries: options.maxRetries || this.defaultMaxRetries,
          abortSignal: options.signal,
        });

        return result.text;
      } catch (error) {
        throw new GenerationError(`Failed to generate conversation response: ${getErrorMessage(error)}`, error);
      }
    });
  }

  /**
   * Stream text generation.
   */
  async *streamText(prompt: string, options: OpenAIStreamOptions = {}): AsyncGenerator<string, void, unknown> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    // Register rate limit slot before starting the stream
    await this.consumeRateLimitSlot('streamText');

    try {
      if (options.onStart) {
        options.onStart();
      }

      const stream = await streamText({
        model: openai(this.model),
        instructions: options.systemPrompt,
        prompt: sanitizedPrompt,
        temperature: options.temperature || this.defaultTemperature,
        abortSignal: options.signal,
      });

      let fullText = '';
      for await (const chunk of stream.textStream) {
        fullText += chunk;

        if (options.onToken) {
          options.onToken(chunk);
        }

        yield chunk;
      }

      if (options.onComplete) {
        options.onComplete(fullText);
      }
    } catch (error) {
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream text: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * Stream conversation with context.
   */
  async *streamConversation(
    messages: ChatMessage[],
    options: OpenAIStreamOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const sanitizedMessages = this.sanitizeMessages(messages);

    // Register rate limit slot before starting the stream
    await this.consumeRateLimitSlot('streamConversation');

    try {
      if (options.onStart) {
        options.onStart();
      }

      const stream = await streamText({
        model: openai(this.model),
        instructions: options.systemPrompt,
        messages: sanitizedMessages,
        temperature: options.temperature || this.defaultTemperature,
        abortSignal: options.signal,
      });

      let fullText = '';
      for await (const chunk of stream.textStream) {
        fullText += chunk;

        if (options.onToken) {
          options.onToken(chunk);
        }

        yield chunk;
      }

      if (options.onComplete) {
        options.onComplete(fullText);
      }
    } catch (error) {
      if (options.onError) {
        options.onError(error as Error);
      }
      throw new GenerationError(`Failed to stream conversation: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * Create a text stream (useful for tRPC streaming endpoints).
   */
  createTextStream(prompt: string, systemPrompt?: string): ReturnType<typeof streamText> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    return streamText({
      model: openai(this.model),
      instructions: systemPrompt,
      prompt: sanitizedPrompt,
      temperature: this.defaultTemperature,
    });
  }

  /**
   * Batch process multiple prompts.
   */
  async batchGenerate<T>(
    prompts: string[],
    schema?: z.ZodSchema<T>,
    options: GenerationOptions = {},
  ): Promise<(T | string)[]> {
    debugService.debug('[OpenAI] Batch generating {promptsLength} prompts (structured: {structured})', {
      promptsLength: prompts.length,
      structured: !!schema,
    });

    const results = await Promise.allSettled(
      prompts.map(prompt =>
        schema ? this.generateStructuredData(prompt, schema, options) : this.generateText(prompt, options),
      ),
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    debugService.debug('[OpenAI] Batch generation complete ({successCount}/{promptsLength} successful)', {
      successCount,
      promptsLength: prompts.length,
    });

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        throw new GenerationError(`Failed to generate for prompt ${index}`, result.reason);
      }
    });
  }

  /**
   * Check if content is appropriate/safe.
   * Note: Input sanitization is intentionally skipped here since the
   * purpose is to analyze raw text for safety.
   */
  async moderateContent(text: string): Promise<{
    safe: boolean;
    categories?: string[];
    confidence?: number;
  }> {
    const moderationSchema = z.object({
      safe: z.boolean(),
      categories: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    });

    const prompt = `Analyze the following content for safety and appropriateness.
Identify any problematic categories if present.

Content: "${text}"`;

    try {
      // Bypass sanitization for moderation — we need to analyze raw text
      return await this.withRateLimit('moderateContent', async () => {
        const result = await generateText({
          model: openai(this.model),
          instructions: 'You are a content moderation assistant. Analyze text for safety.',
          messages: [{ role: 'user', content: prompt }],
          output: Output.object({ schema: moderationSchema }),
          maxRetries: this.defaultMaxRetries,
          temperature: 0.1,
        });

        return result.output;
      });
    } catch (error) {
      throw new GenerationError(`Failed to moderate content: ${getErrorMessage(error)}`, error);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Wraps an async function with rate limiting and proper error handling.
   */
  private async withRateLimit<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = await rateLimiters.openai.execute(key, fn);

    if (!result.success) {
      debugService.debug('[OpenAI] Rate limit exceeded for {key} (retry after: {after}ms)', {
        key,
        after: result.retryAfterMs,
      });

      throw new RateLimitError(
        `Rate limit exceeded for ${key}: retry after ${result.retryAfterMs}ms`,
        result.retryAfterMs,
      );
    }

    return result.data;
  }

  /**
   * Consumes a rate limit slot without wrapping a function.
   * Used for streaming methods where the rate limit check must happen
   * before the generator starts yielding.
   */
  private async consumeRateLimitSlot(key: string): Promise<void> {
    await this.withRateLimit(key, async () => undefined);
  }

  /**
   * Sanitizes a single text input if sanitization is enabled.
   * Returns the original text unchanged when sanitization is disabled.
   *
   * @throws GenerationError if the input is blocked (e.g., prompt injection detected)
   */
  private sanitizeInput(text: string): string {
    if (!this.sanitizer) {
      return text;
    }

    const report = this.sanitizer.sanitize(text);

    if (report.result === 'blocked') {
      debugService.debug('[OpenAI] Input blocked by sanitizer: {sanitizer}', { sanitizer: report.blockedReason });
      throw new GenerationError(`Input blocked: ${report.blockedReason}`);
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
   *
   * @throws GenerationError if any user message is blocked
   */
  private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!this.sanitizer) {
      return messages;
    }

    return messages.map(msg => {
      if (msg.role !== 'user') {
        return msg;
      }
      // Only sanitize plain string content — multimodal content is passed through
      if (typeof msg.content !== 'string') {
        return msg;
      }
      return { role: 'user' as const, content: this.sanitizeInput(msg.content) };
    });
  }
}
