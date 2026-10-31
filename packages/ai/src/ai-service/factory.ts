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

import type { LanguageModel, LanguageModelUsage } from 'ai';
import { anthropic } from '../anthropic';
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { mistral } from '@ai-sdk/mistral';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { generateText, Output, streamText } from 'ai';
import { createOllama } from 'ai-sdk-ollama';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { isFailure } from '@arki/failure';

import type { ProviderFailure } from '../failures';
import type { LLMProviderName } from './provider-names';
import type { GenerateOptions, Generation, LLMProviderWithUsage, Message, StreamOptions } from './types';
import { DEFAULT_LLM_PROVIDER, DEFAULT_OLLAMA_BASE_URL, env } from '../env';
import { modelSchema } from './model-schema';
import { finishFailure, providerFailure, readTextParts } from './provider-failure';
import { aiTelemetry } from './telemetry';

// ── Per-provider model defaults ───────────────────────────────

/** Default Claude model when `LLM_PROVIDER=anthropic` and no `LLM_MODEL` is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

const PROVIDER_DEFAULT_MODELS: Record<LLMProviderName, string> = {
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
  provider?: LLMProviderName;
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
  return config.model ?? env.LLM_MODEL ?? PROVIDER_DEFAULT_MODELS[resolveLlmProvider(config)];
}

/** The provider `createLLMProvider` uses for this config: the explicit `provider`, else `LLM_PROVIDER`, else Ollama. */
export function resolveLlmProvider(config: Pick<LLMProviderConfig, 'provider'> = {}): LLMProviderName {
  return config.provider ?? env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
}

/** The native Ollama address for this config: `baseURL`, else `OLLAMA_BASE_URL`, without a trailing `/v1`. */
export function resolveOllamaBaseUrl(config: Pick<LLMProviderConfig, 'baseURL'> = {}): string {
  return (config.baseURL ?? env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/v1\/?$/u, '');
}

/**
 * Create a provider-agnostic `LLMProviderWithUsage` (a `StructuredLLMProvider` that also reports
 * token usage) from environment config.
 *
 * Reads `LLM_PROVIDER` (default "ollama", local first) and `LLM_MODEL` (optional) from the
 * environment, then accepts per-call overrides via `config`.
 */
export function createLLMProvider(config: LLMProviderConfig = {}): LLMProviderWithUsage {
  const providerName = resolveLlmProvider(config);
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
          baseURL: resolveOllamaBaseUrl(config),
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

  return adaptLanguageModel(languageModel, {
    provider: providerName,
    model,
    temperature: config.temperature ?? 0.7,
    maxRetries: config.maxRetries ?? 2,
    deterministicSeed: config.deterministicSeed ?? env.AI_DETERMINISTIC_SEED,
  });
}

/** What the adapter needs besides the model: names for results and spans, and call defaults. */
type AdapterSettings = {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxRetries: number;
  readonly deterministicSeed: number | undefined;
};

/**
 * Wrap any AI SDK `LanguageModel` as an `LLMProviderWithUsage`. `createLLMProvider` uses it for
 * real providers and `@arki/ai/testing` for its fake, so both run the same schema check.
 * Internal: not exported from the package root.
 */
export function adaptLanguageModel(
  languageModel: LanguageModel | ((signal?: AbortSignal) => LanguageModel),
  settings: AdapterSettings,
): LLMProviderWithUsage {
  return new LanguageModelAdapter(languageModel, settings);
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
class LanguageModelAdapter implements LLMProviderWithUsage {
  readonly provider: string;
  readonly model: string;

  constructor(
    private readonly languageModel: LanguageModel | ((signal?: AbortSignal) => LanguageModel),
    private readonly settings: AdapterSettings,
  ) {
    this.provider = settings.provider;
    this.model = settings.model;
  }

  /** The model for one call; Ollama's is built per call so it carries the call's abort signal. */
  private modelFor(signal: AbortSignal | undefined): LanguageModel {
    return typeof this.languageModel === 'function' ? this.languageModel(signal) : this.languageModel;
  }

  /** The sampling settings of one call: the asked temperature, or temperature 0 + the seed in deterministic mode. */
  private sampling(options: { readonly temperature?: number }): { temperature: number; seed?: number } {
    const { deterministicSeed, temperature } = this.settings;
    if (deterministicSeed === undefined) return { temperature: options.temperature ?? temperature };
    return { temperature: 0, seed: deterministicSeed };
  }

  /** The options every call shares. */
  private callOptions(options: GenerateOptions, operation: string) {
    return {
      model: this.modelFor(options.signal),
      system: options.systemPrompt,
      ...this.sampling(options),
      maxRetries: options.maxRetries ?? this.settings.maxRetries,
      abortSignal: options.signal,
      maxOutputTokens: options.maxTokens,
      ...aiTelemetry(`${this.provider}.${operation}`),
    };
  }

  /** The value with the call's total usage (all steps) and this provider's names. */
  private generation<T>(value: T, usage: LanguageModelUsage): Generation<T> {
    return {
      value,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      provider: this.provider,
      model: this.model,
    };
  }

  /** The names and signal of one call, for `providerFailure`. */
  private call(options: GenerateOptions) {
    return { provider: this.provider, model: this.model, signal: options.signal };
  }

  async generateStructuredResult<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options: GenerateOptions = {},
  ): Promise<Generation<SchemaOutput<S>> | ProviderFailure> {
    try {
      const result = await generateText({
        ...this.callOptions(options, 'generateStructuredData'),
        prompt,
        output: Output.object({ schema: modelSchema(schema, `${this.provider} structured generation`) }),
      });
      return finishFailure(result.finishReason, this.call(options)) ?? this.generation(result.output, result.totalUsage);
    } catch (error) {
      return providerFailure(error, this.call(options));
    }
  }

  async generateStructuredData<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options: GenerateOptions = {},
  ): Promise<SchemaOutput<S> | ProviderFailure> {
    const result = await this.generateStructuredResult(prompt, schema, options);
    return isFailure(result) ? result : result.value;
  }

  async generateStructuredDataFromMessages<S extends StandardSchemaV1>(
    messages: Message[],
    schema: S,
    options: GenerateOptions = {},
  ): Promise<SchemaOutput<S> | ProviderFailure> {
    try {
      const result = await generateText({
        ...this.callOptions(options, 'generateStructuredDataFromMessages'),
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        output: Output.object({ schema: modelSchema(schema, `${this.provider} structured generation`) }),
      });
      return finishFailure(result.finishReason, this.call(options)) ?? result.output;
    } catch (error) {
      return providerFailure(error, this.call(options));
    }
  }

  async generateTextResult(prompt: string, options: GenerateOptions = {}): Promise<Generation<string> | ProviderFailure> {
    try {
      const result = await generateText({ ...this.callOptions(options, 'generateText'), prompt });
      return finishFailure(result.finishReason, this.call(options)) ?? this.generation(result.text, result.totalUsage);
    } catch (error) {
      return providerFailure(error, this.call(options));
    }
  }

  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string | ProviderFailure> {
    const result = await this.generateTextResult(prompt, options);
    return isFailure(result) ? result : result.value;
  }

  async *streamConversation(
    messages: Message[],
    options: StreamOptions = {},
  ): AsyncGenerator<string | ProviderFailure, void, unknown> {
    let stream;
    try {
      stream = streamText({
        ...this.callOptions(options, 'streamConversation'),
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });
    } catch (error) {
      const failure = providerFailure(error, this.call(options));
      options.onError?.(failure);
      yield failure;
      return;
    }
    let text = '';
    for await (const chunk of readTextParts(stream.fullStream, this.call(options))) {
      if (isFailure(chunk)) {
        options.onError?.(chunk);
        yield chunk;
        return;
      }
      text += chunk;
      options.onChunk?.(chunk);
      yield chunk;
    }
    options.onComplete?.(text);
  }
}
