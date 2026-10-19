/**
 * LLM Provider Factory
 *
 * Returns a `StructuredLLMProvider` wired to the configured backend.
 * Provider selection is driven by the `LLM_PROVIDER` environment variable
 * (default: "ollama"). Per-call model and temperature overrides are accepted
 * via the `config` parameter.
 *
 * Usage:
 *   const llm = createLLMProvider({ model: 'gpt-4o-mini', temperature: 0.3 });
 *   const result = await llm.generateStructuredData(prompt, schema);
 *
 * To switch providers at runtime, set:
 *   LLM_PROVIDER=anthropic   LLM_MODEL=claude-sonnet-5-5
 *   LLM_PROVIDER=groq         LLM_MODEL=openai/gpt-oss-20b
 *   LLM_PROVIDER=google       LLM_MODEL=gemini-2.0-flash
 *   LLM_PROVIDER=mistral      LLM_MODEL=mistral-small-latest
 */

import type { LanguageModel } from 'ai';
import { anthropic } from '../anthropic';
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { mistral } from '@ai-sdk/mistral';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { generateText, Output, streamText } from 'ai';
import { createOllama } from 'ai-sdk-ollama';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type { GenerateOptions, Message, StreamOptions, StructuredLLMProvider } from './types';
import { DEFAULT_LLM_PROVIDER, DEFAULT_OLLAMA_BASE_URL, env } from '../env';
import { GenerationError, getErrorMessage } from '../errors';
import { modelSchema } from './model-schema';
import { aiTelemetry } from './telemetry';

// ── Per-provider model defaults ───────────────────────────────

/** Default Claude model when `LLM_PROVIDER=anthropic` and no `LLM_MODEL` is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  ollama: 'qwen3.6:latest',
  openai: 'gpt-4o-mini',
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  groq: 'openai/gpt-oss-20b',
  google: 'gemini-2.0-flash',
  mistral: 'mistral-small-latest',
};

// ── Config type ────────────────────────────────────────────────

export type LLMProviderConfig = {
  /** Explicit provider override for a capability. */
  provider?: 'ollama' | 'openai' | 'anthropic' | 'groq' | 'google' | 'mistral';
  /** Endpoint override: native Ollama or OpenAI-compatible chat completions. */
  baseURL?: string;
  /** Credential for the endpoint override; otherwise uses OPENAI_API_KEY. */
  apiKey?: string;
  /** Override the default model for the active provider. */
  model?: string;
  /** Default temperature for all calls (0–1). */
  temperature?: number;
  /** Maximum retries on transient failures. */
  maxRetries?: number;
  /**
   * Run every call at temperature 0 with this seed, overriding any per-call temperature, so the
   * same input gets the same answer (as far as the provider honours a seed; Ollama does).
   * Defaults to `AI_DETERMINISTIC_SEED`; meant for tests on a real local model.
   */
  deterministicSeed?: number;
};

// ── Factory ───────────────────────────────────────────────────

/**
 * The model id `createLLMProvider` uses for this config: the explicit `model`,
 * else `LLM_MODEL`, else the provider default. Use it to record which model
 * produced an output.
 */
export function resolveLlmModel(config: Pick<LLMProviderConfig, 'provider' | 'model'> = {}): string {
  const providerName = config.provider ?? env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
  return config.model ?? env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[providerName] ?? 'gpt-4o-mini';
}

/**
 * Create a provider-agnostic `StructuredLLMProvider` from environment config.
 *
 * Reads `LLM_PROVIDER` (default "ollama", local first) and `LLM_MODEL` (optional) from the
 * environment, then accepts per-call overrides via `config`.
 */
export function createLLMProvider(config: LLMProviderConfig = {}): StructuredLLMProvider {
  const providerName = config.provider ?? env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
  const model = resolveLlmModel(config);

  if (config.baseURL && !['openai', 'ollama'].includes(providerName))
    throw new Error('baseURL requires openai or ollama provider');
  let languageModel: LanguageModel | ((signal?: AbortSignal) => LanguageModel);

  switch (providerName) {
    case 'ollama': {
      // ai-sdk-ollama's native client omits the AI SDK abort signal from HTTP calls.
      // A model per call binds cancellation without mutating a shared client.
      languageModel = signal =>
        createOllama({
          baseURL: (config.baseURL ?? env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/v1\/?$/u, ''),
          fetch: (input, init) => fetch(input, { ...init, signal }),
        })(model);
      break;
    }
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
      languageModel = config.baseURL
        ? createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey ?? env.OPENAI_API_KEY ?? 'local' }).chat(model)
        : openai(model);
    }
  }

  return new LanguageModelAdapter(
    languageModel,
    providerName,
    model,
    config.temperature ?? 0.7,
    config.maxRetries ?? 2,
    config.deterministicSeed ?? env.AI_DETERMINISTIC_SEED,
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
    private readonly languageModel: LanguageModel | ((signal?: AbortSignal) => LanguageModel),
    private readonly providerName: string,
    private readonly modelName: string,
    private readonly defaultTemperature: number,
    private readonly defaultMaxRetries: number,
    private readonly deterministicSeed: number | undefined,
  ) {}

  /** The sampling settings of one call: the asked temperature, or temperature 0 + the seed in deterministic mode. */
  private sampling(options: { readonly temperature?: number }): { temperature: number; seed?: number } {
    if (this.deterministicSeed === undefined) return { temperature: options.temperature ?? this.defaultTemperature };
    return { temperature: 0, seed: this.deterministicSeed };
  }

  async generateStructuredData<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options: GenerateOptions = {},
  ): Promise<SchemaOutput<S>> {
    try {
      const result = await generateText({
        model: typeof this.languageModel === 'function' ? this.languageModel(options.signal) : this.languageModel,
        system: options.systemPrompt,
        prompt,
        output: Output.object({ schema: modelSchema(schema, `${this.providerName} structured generation`) }),
        ...this.sampling(options),
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        maxOutputTokens: options.maxTokens,
        ...aiTelemetry(`${this.providerName}.generateStructuredData`),
      });
      if (result.finishReason !== 'stop') throw new Error(`Incomplete generation: ${result.finishReason}`);
      return result.output;
    } catch (error) {
      throw new GenerationError(
        `[${this.providerName}/${this.modelName}] Structured generation failed: ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  async generateStructuredDataFromMessages<S extends StandardSchemaV1>(
    messages: Message[],
    schema: S,
    options: GenerateOptions = {},
  ): Promise<SchemaOutput<S>> {
    try {
      const result = await generateText({
        model: typeof this.languageModel === 'function' ? this.languageModel(options.signal) : this.languageModel,
        system: options.systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        output: Output.object({ schema: modelSchema(schema, `${this.providerName} structured generation`) }),
        ...this.sampling(options),
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        maxOutputTokens: options.maxTokens,
        ...aiTelemetry(`${this.providerName}.generateStructuredDataFromMessages`),
      });
      if (result.finishReason !== 'stop') throw new Error(`Incomplete generation: ${result.finishReason}`);
      return result.output;
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
        model: typeof this.languageModel === 'function' ? this.languageModel(options.signal) : this.languageModel,
        system: options.systemPrompt,
        prompt,
        ...this.sampling(options),
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        maxOutputTokens: options.maxTokens,
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
        model: typeof this.languageModel === 'function' ? this.languageModel(options.signal) : this.languageModel,
        system: options.systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        ...this.sampling(options),
        maxRetries: options.maxRetries ?? this.defaultMaxRetries,
        abortSignal: options.signal,
        maxOutputTokens: options.maxTokens,
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
