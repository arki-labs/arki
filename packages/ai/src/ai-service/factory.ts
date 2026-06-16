/**
 * LLM Provider Factory
 *
 * Returns a `StructuredLLMProvider` wired to the configured backend.
 * Provider selection is driven by the `LLM_PROVIDER` environment variable
 * (default: "openai"). Per-call model and temperature overrides are accepted
 * via the `config` parameter.
 *
 * Usage:
 *   const llm = createLLMProvider({ model: 'gpt-4o-mini', temperature: 0.3 });
 *   const result = await llm.generateStructuredData(prompt, schema);
 *
 * To switch providers at runtime, set:
 *   LLM_PROVIDER=anthropic   LLM_MODEL=claude-3-5-haiku-latest
 *   LLM_PROVIDER=groq         LLM_MODEL=llama-3.1-8b-instant
 *   LLM_PROVIDER=google       LLM_MODEL=gemini-2.0-flash
 *   LLM_PROVIDER=mistral      LLM_MODEL=mistral-small-latest
 */

import type { LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { mistral } from '@ai-sdk/mistral';
import { openai } from '@ai-sdk/openai';
import { Output, generateText, streamText } from 'ai';

import type { z } from '@arki/contracts';

import type { GenerateOptions, Message, StreamOptions, StructuredLLMProvider } from './types';
import { env } from '../env';
import { GenerationError, getErrorMessage } from '../errors';
import { aiTelemetry } from './telemetry';

// ── Per-provider model defaults ───────────────────────────────

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  groq: 'llama-3.1-8b-instant',
  google: 'gemini-2.0-flash',
  mistral: 'mistral-small-latest',
};

// ── Config type ────────────────────────────────────────────────

export type LLMProviderConfig = {
  /** Override the default model for the active provider. */
  model?: string;
  /** Default temperature for all calls (0–1). */
  temperature?: number;
  /** Maximum retries on transient failures. */
  maxRetries?: number;
};

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a provider-agnostic `StructuredLLMProvider` from environment config.
 *
 * Reads `LLM_PROVIDER` (default "openai") and `LLM_MODEL` (optional) from the
 * environment, then accepts per-call overrides via `config`.
 */
export function createLLMProvider(config: LLMProviderConfig = {}): StructuredLLMProvider {
  const providerName = env.LLM_PROVIDER;
  const model = config.model ?? env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[providerName] ?? 'gpt-4o-mini';

  let languageModel: LanguageModel;

  switch (providerName) {
    case 'anthropic': {
      languageModel = anthropic(model);
      break;
    }
    case 'groq': {
      languageModel = groq(model);
      break;
    }
    case 'google': {
      languageModel = google(model);
      break;
    }
    case 'mistral': {
      languageModel = mistral(model);
      break;
    }
    default: {
      languageModel = openai(model);
    }
  }

  return new LanguageModelAdapter(
    languageModel,
    providerName,
    model,
    config.temperature ?? 0.7,
    config.maxRetries ?? 2,
  );
}

// ── Adapter ───────────────────────────────────────────────────

/**
 * Wraps a Vercel AI SDK `LanguageModel` and implements `StructuredLLMProvider`.
 * All methods use the provider-neutral AI SDK primitives — `generateText`
 * with `output: Output.object({ schema })` for structured output, and
 * `streamText` for streaming — so the same code path works for every
 * backend. The deprecated `generateObject` / `streamObject` paths are
 * NOT used.
 */
class LanguageModelAdapter implements StructuredLLMProvider {
  constructor(
    private readonly languageModel: LanguageModel,
    private readonly providerName: string,
    private readonly modelName: string,
    private readonly defaultTemperature: number,
    private readonly defaultMaxRetries: number,
  ) {}

  async generateStructuredData<T>(prompt: string, schema: z.ZodSchema<T>, options: GenerateOptions = {}): Promise<T> {
    try {
      const result = await generateText({
        model: this.languageModel,
        system: options.systemPrompt,
        prompt,
        output: Output.object({ schema: schema as z.ZodSchema }),
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        ...aiTelemetry(`${this.providerName}.generateStructuredData`),
      });
      return result.output as T;
    } catch (error) {
      throw new GenerationError(
        `[${this.providerName}/${this.modelName}] Structured generation failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  async generateStructuredDataFromMessages<T>(
    messages: Message[],
    schema: z.ZodSchema<T>,
    options: GenerateOptions = {},
  ): Promise<T> {
    try {
      const result = await generateText({
        model: this.languageModel,
        system: options.systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        output: Output.object({ schema: schema as z.ZodSchema }),
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        ...aiTelemetry(`${this.providerName}.generateStructuredDataFromMessages`),
      });
      return result.output as T;
    } catch (error) {
      throw new GenerationError(
        `[${this.providerName}/${this.modelName}] Structured generation from messages failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    try {
      const result = await generateText({
        model: this.languageModel,
        system: options.systemPrompt,
        prompt,
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        ...aiTelemetry(`${this.providerName}.generateText`),
      });
      return result.text;
    } catch (error) {
      throw new GenerationError(
        `[${this.providerName}/${this.modelName}] Text generation failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  async *streamConversation(messages: Message[], options: StreamOptions = {}): AsyncGenerator<string, void, unknown> {
    try {
      const stream = streamText({
        model: this.languageModel,
        system: options.systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options.temperature ?? this.defaultTemperature,
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        ...aiTelemetry(`${this.providerName}.streamConversation`),
      });

      for await (const chunk of (await stream).textStream) {
        options.onChunk?.(chunk);
        yield chunk;
      }
    } catch (error) {
      options.onError?.(error as Error);
      throw new GenerationError(
        `[${this.providerName}/${this.modelName}] Stream conversation failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }
}
