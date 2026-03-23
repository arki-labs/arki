/**
 * Generic OpenAI Service using Vercel AI SDK
 * Provides reusable AI generation capabilities with built-in
 * rate limiting and optional input sanitization.
 */

import { openai } from '@ai-sdk/openai';
import { generateObject, streamText, generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from '@arki/contracts';

import { debugService } from '../debug.ts';
import { GenerationError, RateLimitError, getErrorMessage } from '../errors';
import { BaseInputSanitizer } from '../safety/input-sanitizer';
import type { SanitizerConfig } from '../safety/types';
import { validateInput, aiServiceConfigSchema } from '../validation';
import { rateLimiters } from '../utils/rate-limiter';

type ChatMessage = ModelMessage;

export type OpenAIServiceConfig = {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
  /** Enable input sanitization. `true` uses defaults; pass config object for customization. */
  sanitize?: boolean | SanitizerConfig;
}

export type GenerationOptions = {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  systemPrompt?: string;
}

export type OpenAIStreamOptions = {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
} & GenerationOptions

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
      const sanitizerConfig = typeof validConfig.sanitize === 'object'
        ? validConfig.sanitize
        : undefined;
      this.sanitizer = new BaseInputSanitizer(sanitizerConfig);
      debugService('[OpenAI] Input sanitization enabled');
    } else {
      this.sanitizer = null;
    }

    debugService(
      '[OpenAI] Service initialized (model: %s, temperature: %d, maxRetries: %d, sanitize: %s)',
      this.model,
      this.defaultTemperature,
      this.defaultMaxRetries,
      !!this.sanitizer,
    );
  }

  /**
   * Generate structured data from a prompt.
   */
  async generateStructuredData<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: GenerationOptions = {}
  ): Promise<T> {
    return this.generateStructuredDataFromMessages(
      [{ role: 'user', content: prompt }],
      schema,
      options,
    );
  }

  /**
   * Generate structured data using explicit message payloads.
   * Supports multimodal content (e.g., including images).
   */
  async generateStructuredDataFromMessages<T>(
    messages: ChatMessage[],
    schema: z.ZodSchema<T>,
    options: GenerationOptions = {}
  ): Promise<T> {
    const sanitizedMessages = this.sanitizeMessages(messages);

    debugService(
      '[OpenAI] Generating structured data (messages: %d, temperature: %d)',
      sanitizedMessages.length,
      options.temperature || this.defaultTemperature,
    );

    return this.withRateLimit('generateStructuredData', async () => {
      try {
        debugService('[OpenAI] Calling OpenAI API for structured generation');

        const result = await generateObject({
          model: openai(this.model),
          system: options.systemPrompt,
          messages: sanitizedMessages,
          output: 'object',
          schema: schema as z.ZodSchema, // Zod schema is compatible but types don't align perfectly with AI SDK
          maxRetries: options.maxRetries || this.defaultMaxRetries,
          temperature: options.temperature || this.defaultTemperature,
        });

        debugService('[OpenAI] Structured data generated successfully');

        return result.object as T;
      } catch (error) {
        debugService('[OpenAI] Structured generation failed: %s', getErrorMessage(error));

        throw new GenerationError(
          `Failed to generate structured data: ${getErrorMessage(error)}`,
          error,
        );
      }
    });
  }

  /**
   * Generate text completion.
   */
  async generateText(
    prompt: string,
    options: GenerationOptions = {}
  ): Promise<string> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    debugService('[OpenAI] Generating text (prompt length: %d)', sanitizedPrompt.length);

    return this.withRateLimit('generateText', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          system: options.systemPrompt,
          prompt: sanitizedPrompt,
          temperature: options.temperature || this.defaultTemperature,
          maxRetries: options.maxRetries || this.defaultMaxRetries,
        });

        debugService('[OpenAI] Text generated successfully (length: %d)', result.text.length);

        return result.text;
      } catch (error) {
        debugService('[OpenAI] Text generation failed: %s', getErrorMessage(error));

        throw new GenerationError(
          `Failed to generate text: ${getErrorMessage(error)}`,
          error,
        );
      }
    });
  }

  /**
   * Generate text with conversation context.
   */
  async generateConversation(
    messages: ChatMessage[],
    options: GenerationOptions = {}
  ): Promise<string> {
    const sanitizedMessages = this.sanitizeMessages(messages);

    return this.withRateLimit('generateConversation', async () => {
      try {
        const result = await generateText({
          model: openai(this.model),
          messages: sanitizedMessages,
          temperature: options.temperature || this.defaultTemperature,
          maxRetries: options.maxRetries || this.defaultMaxRetries,
        });

        return result.text;
      } catch (error) {
        throw new GenerationError(
          `Failed to generate conversation response: ${getErrorMessage(error)}`,
          error,
        );
      }
    });
  }

  /**
   * Stream text generation.
   */
  async *streamText(
    prompt: string,
    options: OpenAIStreamOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    // Register rate limit slot before starting the stream
    await this.consumeRateLimitSlot('streamText');

    try {
      if (options.onStart) {
        options.onStart();
      }

      const stream = await streamText({
        model: openai(this.model),
        system: options.systemPrompt,
        prompt: sanitizedPrompt,
        temperature: options.temperature || this.defaultTemperature,
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
      throw new GenerationError(
        `Failed to stream text: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Stream conversation with context.
   */
  async *streamConversation(
    messages: ChatMessage[],
    options: OpenAIStreamOptions = {}
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
        messages: sanitizedMessages,
        temperature: options.temperature || this.defaultTemperature,
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
      throw new GenerationError(
        `Failed to stream conversation: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Create a text stream (useful for tRPC streaming endpoints).
   */
  createTextStream(prompt: string, systemPrompt?: string): ReturnType<typeof streamText> {
    const sanitizedPrompt = this.sanitizeInput(prompt);

    return streamText({
      model: openai(this.model),
      system: systemPrompt,
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
    options: GenerationOptions = {}
  ): Promise<(T | string)[]> {
    debugService('[OpenAI] Batch generating %d prompts (structured: %s)', prompts.length, !!schema);

    const results = await Promise.allSettled(
      prompts.map(prompt =>
        schema
          ? this.generateStructuredData(prompt, schema, options)
          : this.generateText(prompt, options)
      )
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    debugService('[OpenAI] Batch generation complete (%d/%d successful)', successCount, prompts.length);

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        throw new GenerationError(
          `Failed to generate for prompt ${index}`,
          result.reason,
        );
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
        const result = await generateObject({
          model: openai(this.model),
          system: 'You are a content moderation assistant. Analyze text for safety.',
          messages: [{ role: 'user', content: prompt }],
          output: 'object',
          schema: moderationSchema,
          maxRetries: this.defaultMaxRetries,
          temperature: 0.1,
        });

        return result.object;
      });
    } catch (error) {
      throw new GenerationError(
        `Failed to moderate content: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Wraps an async function with rate limiting and proper error handling.
   */
  private async withRateLimit<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const result = await rateLimiters.openai.execute(key, fn);

    if (!result.success) {
      debugService('[OpenAI] Rate limit exceeded for %s (retry after: %dms)', key, result.retryAfterMs);

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
      debugService('[OpenAI] Input blocked by sanitizer: %s', report.blockedReason);
      throw new GenerationError(
        `Input blocked: ${report.blockedReason}`,
      );
    }

    if (report.result === 'sanitized' && report.sanitizedInput) {
      debugService(
        '[OpenAI] Input sanitized (%d issues found)',
        report.issuesFound.length,
      );
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
