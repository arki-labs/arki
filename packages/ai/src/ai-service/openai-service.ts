/**
 * Generic OpenAI Service using Vercel AI SDK
 * Provides reusable AI generation capabilities
 */

import { openai } from '@ai-sdk/openai';
import { generateObject, streamText, generateText } from 'ai';
import type { CoreMessage } from 'ai';
import { z } from '@arki/contracts';
import { debugService } from '../debug.ts';
import { GenerationError, getErrorMessage } from '../errors';
import { validateInput, aiServiceConfigSchema } from '../validation';
import { rateLimiters } from '../utils/rate-limiter';

export interface OpenAIServiceConfig {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxRetries?: number;
}

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  systemPrompt?: string;
}

export interface StreamOptions extends GenerationOptions {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Generic OpenAI Service for various AI tasks
 */
export class OpenAIService {
  private model: string;
  private defaultTemperature: number;
  private defaultMaxRetries: number;
  // private apiKey: string; // Reserved for future use

  constructor(config: OpenAIServiceConfig = {}) {
    const validConfig = validateInput(aiServiceConfigSchema, config);
    this.model = validConfig.model || 'gpt-4o-mini';
    this.defaultTemperature = validConfig.temperature || 0.7;
    this.defaultMaxRetries = validConfig.maxRetries || 2;

    debugService(
      '[OpenAI] Service initialized (model: %s, temperature: %d, maxRetries: %d)',
      this.model,
      this.defaultTemperature,
      this.defaultMaxRetries,
    );

    // API key handling is managed through environment variables
    // See env.ts for configuration
  }

  /**
   * Generate structured data from a prompt
   */
  async generateStructuredData<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: GenerationOptions = {}
  ): Promise<T> {
    return this.generateStructuredDataFromMessages(
      [
        {
          role: 'user',
          content: prompt,
        },
      ],
      schema,
      options,
    );
  }

  /**
   * Generate structured data using explicit message payloads
   * Supports multimodal content (e.g., including images)
   */
  async generateStructuredDataFromMessages<T>(
    messages: CoreMessage[],
    schema: z.ZodSchema<T>,
    options: GenerationOptions = {}
  ): Promise<T> {
    debugService('[OpenAI] Generating structured data (messages: %d, temperature: %d)', messages.length, options.temperature || this.defaultTemperature);

    // Apply rate limiting
    const rateLimitResult = await rateLimiters.openai.execute(
      'generateStructuredDataFromMessages',
      async () => {
        try {
          debugService('[OpenAI] Calling OpenAI API for structured generation');

          const result = await generateObject({
            model: openai(this.model),
            system: options.systemPrompt,
            messages,
            output: 'object',
            schema: schema as any, // Zod schema is compatible but types don't align perfectly with AI SDK
            maxRetries: options.maxRetries || this.defaultMaxRetries,
            temperature: options.temperature || this.defaultTemperature,
          });

          debugService('[OpenAI] Structured data generated successfully');

          return result.object as T;
        } catch (error) {
          debugService('[OpenAI] Structured generation failed: %s', getErrorMessage(error));

          throw new GenerationError(
            `Failed to generate structured data: ${getErrorMessage(error)}`,
            error
          );
        }
      }
    );

    if (!rateLimitResult.success) {
      debugService('[OpenAI] Rate limit exceeded (retry after: %dms)', rateLimitResult.retryAfterMs);

      throw new GenerationError(
        `Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`,
        rateLimitResult.error
      );
    }

    return rateLimitResult.data!;
  }

  /**
   * Generate text completion
   */
  async generateText(
    prompt: string,
    options: GenerationOptions = {}
  ): Promise<string> {
    debugService('[OpenAI] Generating text (prompt length: %d)', prompt.length);

    try {
      const result = await generateText({
        model: openai(this.model),
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature || this.defaultTemperature,
        maxRetries: options.maxRetries || this.defaultMaxRetries,
      });

      debugService('[OpenAI] Text generated successfully (length: %d)', result.text.length);

      return result.text;
    } catch (error) {
      debugService('[OpenAI] Text generation failed: %s', getErrorMessage(error));

      throw new GenerationError(
        `Failed to generate text: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  /**
   * Generate text with conversation context
   */
  async generateConversation(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: GenerationOptions = {}
  ): Promise<string> {
    try {
      const coreMessages: CoreMessage[] = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      const result = await generateText({
        model: openai(this.model),
        messages: coreMessages,
        temperature: options.temperature || this.defaultTemperature,
        maxRetries: options.maxRetries || this.defaultMaxRetries,
      });

      return result.text;
    } catch (error) {
      throw new GenerationError(
        `Failed to generate conversation response: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  /**
   * Stream text generation
   */
  async *streamText(
    prompt: string,
    options: StreamOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    try {
      if (options.onStart) {
        options.onStart();
      }

      const stream = await streamText({
        model: openai(this.model),
        system: options.systemPrompt,
        prompt,
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
        error
      );
    }
  }

  /**
   * Stream conversation with context
   */
  async *streamConversation(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: StreamOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    try {
      if (options.onStart) {
        options.onStart();
      }

      const coreMessages: CoreMessage[] = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      const stream = await streamText({
        model: openai(this.model),
        messages: coreMessages,
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
        error
      );
    }
  }

  /**
   * Create a text stream (useful for tRPC streaming endpoints)
   */
  createTextStream(prompt: string, systemPrompt?: string) {
    return streamText({
      model: openai(this.model),
      system: systemPrompt,
      prompt,
      temperature: this.defaultTemperature,
    });
  }

  /**
   * Batch process multiple prompts
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
          result.reason
        );
      }
    });
  }

  /**
   * Generate embeddings for text
   * Note: For embeddings, use the dedicated embedding providers in the embeddings module
   * This is removed as the AI SDK doesn't support embeddings directly
   */

  /**
   * Check if content is appropriate/safe
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
      const result = await this.generateStructuredData(
        prompt,
        moderationSchema,
        {
          systemPrompt: 'You are a content moderation assistant. Analyze text for safety.',
          temperature: 0.1, // Low temperature for consistent moderation
        }
      );

      return result;
    } catch (error) {
      // In case of moderation failure, default to safe but throw error for visibility
      throw new GenerationError(
        `Failed to moderate content: ${getErrorMessage(error)}`,
        error
      );
    }
  }
}
