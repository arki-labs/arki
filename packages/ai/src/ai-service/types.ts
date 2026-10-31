/**
 * Common LLM Provider Interface
 *
 * Defines a unified interface for interacting with different LLM providers
 * (OpenAI, Anthropic, Groq, Google, Mistral, OpenRouter) through the Vercel AI SDK.
 */

import type { LanguageModelUsage } from 'ai';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type { ProviderFailure } from '../failures.js';

/**
 * Message format for conversation-based interactions
 */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

/**
 * Common options for text generation
 */
export type GenerateOptions = {
  /** Temperature for response randomness (0-1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Stop sequences to end generation */
  stopSequences?: string[];
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Number of retries on failure */
  maxRetries?: number;
  /**
   * Abort signal honored by the underlying provider.
   *
   * When the signal aborts (e.g., a cockatiel timeout fires), the SDK
   * stops streaming, closes the HTTP connection, and the model on the
   * other end stops generating tokens. Without this, "timed out" calls
   * keep running on the daemon — wasted compute and hidden cost.
   *
   * Optional: callers that don't need cancellation can omit it; the
   * SDK proceeds normally.
   */
  signal?: AbortSignal;
};

/**
 * Options specific to streaming generation
 */
export type StreamOptions = {
  /** Callback for each chunk received */
  onChunk?: (chunk: string) => void;
  /** Callback when stream completes */
  onComplete?: (fullText: string) => void;
  /** Called with the failure that ends the stream, just before the stream yields it */
  onError?: (failure: ProviderFailure) => void;
} & GenerateOptions;

/**
 * Provider health status
 */
export type ProviderHealth = {
  /** Whether the provider is currently healthy */
  isHealthy: boolean;
  /** Last successful request timestamp */
  lastSuccess?: Date;
  /** Last failure timestamp */
  lastFailure?: Date;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Error message from last failure */
  lastError?: string;
};

/**
 * Configuration for a provider in the rotation
 */
export type ProviderConfig = {
  /** Provider identifier */
  name: 'groq' | 'google' | 'mistral' | 'openrouter' | 'openai' | 'anthropic';
  /** Model to use for this provider */
  model: string;
  /** Weight for weighted round-robin selection (higher = more likely to be selected) */
  weight?: number;
  /** Whether this provider is enabled */
  enabled?: boolean;
  /** Optional API key override — when set, used instead of the default env-based key */
  apiKey?: string;
};

/**
 * Result from a provider operation
 */
export type ProviderResult<T> = {
  /** The result data */
  data: T;
  /** Which provider handled the request */
  provider: string;
  /** Time taken in milliseconds */
  durationMs: number;
};

/**
 * Common interface for all LLM providers
 *
 * All provider implementations must implement this interface to ensure
 * compatibility with the ProviderRouter for rotation and fallback.
 */
export type LLMProvider = {
  /** Provider name identifier */
  readonly name: string;

  /** Model being used */
  readonly model: string;

  /**
   * Generate text from a single prompt
   *
   * @param prompt - The input prompt
   * @param options - Generation options
   * @returns Generated text, or a `ProviderFailure` (local or provider rate limit, refusal, truncation, outage, cancel)
   */
  generateText(prompt: string, options?: GenerateOptions): Promise<string | ProviderFailure>;

  /**
   * Generate text from a conversation history
   *
   * @param messages - Array of conversation messages
   * @param options - Generation options
   * @returns Generated response text, or a `ProviderFailure`
   */
  generateConversation(messages: Message[], options?: GenerateOptions): Promise<string | ProviderFailure>;

  /**
   * Stream text generation from a single prompt
   *
   * @param prompt - The input prompt
   * @param options - Stream options
   * @yields Text chunks as they're generated; a `ProviderFailure` is the last item when the stream fails or stops early
   */
  streamText(prompt: string, options?: StreamOptions): AsyncGenerator<string | ProviderFailure, void, unknown>;

  /**
   * Stream text generation from a conversation history
   *
   * @param messages - Array of conversation messages
   * @param options - Stream options
   * @yields Text chunks as they're generated; a `ProviderFailure` is the last item when the stream fails or stops early
   */
  streamConversation(messages: Message[], options?: StreamOptions): AsyncGenerator<string | ProviderFailure, void, unknown>;

  /**
   * Check if the provider is available (has API key configured)
   *
   * @returns Whether the provider can be used
   */
  isAvailable(): boolean;
};

/**
 * Factory function type for creating LLM providers
 */
export type LLMProviderFactory = (config?: {
  model?: string;
  temperature?: number;
  maxRetries?: number;
}) => LLMProvider;

/**
 * Provider-agnostic interface for structured LLM generation.
 *
 * Any LLM (OpenAI, Anthropic, Groq, …) that implements this interface
 * can be used interchangeably by @arki/ai capabilities and app services.
 * Use `createLLMProvider(config?)` to obtain an instance driven by the
 * `LLM_PROVIDER` environment variable.
 */
export type StructuredLLMProvider = {
  /**
   * Generate a structured object from a single prompt.
   * Any Standard Schema works (zod, valibot, arktype, ...). The model is shown the schema's input
   * JSON Schema and writes raw JSON; the result is that JSON run through the schema, so it has
   * the schema's OUTPUT type (a transform has already run). Output the schema rejects is returned
   * as `InvalidOutput`; every other way the call can fail is a returned `ProviderFailure` too.
   */
  generateStructuredData<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options?: GenerateOptions,
  ): Promise<SchemaOutput<S> | ProviderFailure>;

  /**
   * Generate a structured object from a conversation history.
   * Useful for multi-turn interactions where context matters.
   */
  generateStructuredDataFromMessages<S extends StandardSchemaV1>(
    messages: Message[],
    schema: S,
    options?: GenerateOptions,
  ): Promise<SchemaOutput<S> | ProviderFailure>;

  /**
   * Generate plain text from a single prompt. A cut-off answer (`length`) is `IncompleteGeneration`,
   * a filtered one `ContentFiltered`: text is only returned when the model finished.
   */
  generateText(prompt: string, options?: GenerateOptions): Promise<string | ProviderFailure>;

  /**
   * Stream a conversational response, yielding text chunks as they arrive.
   * Used for real-time copilot streaming endpoints. When the stream fails or stops early, its last
   * item is the `ProviderFailure`; a stream that ends on a string finished normally.
   */
  streamConversation(messages: Message[], options?: StreamOptions): AsyncGenerator<string | ProviderFailure, void, unknown>;
};

/**
 * The tokens one call used, under the AI SDK's names. A count is `undefined` when the provider
 * did not report it; never read it as zero.
 */
export type GenerationUsage = Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'>;

/** What one call produced, with the provider and model that produced it and the tokens it used. */
export type Generation<T> = {
  readonly value: T;
  readonly usage: GenerationUsage;
  readonly provider: string;
  readonly model: string;
};

/**
 * What `createLLMProvider` returns: a `StructuredLLMProvider` that also names its provider and
 * model, and has `...Result` methods that hand back token usage with the value. Code that only
 * needs the value keeps typing against `StructuredLLMProvider`.
 *
 * @example
 * ```ts
 * const llm = createLLMProvider();
 * const answer = await llm.generateStructuredResult('Name one planet.', z.object({ planet: z.string() }));
 * if (isFailure(answer)) return answer;
 * answer.value.planet; // 'Mars'
 * answer.usage.outputTokens; // 12
 * ```
 */
export type LLMProviderWithUsage = StructuredLLMProvider & {
  /** The provider name, e.g. `ollama`. */
  readonly provider: string;
  /** The model id every call uses. */
  readonly model: string;
  /** `generateStructuredData`, with the token usage of the call next to the value. Fails as it does. */
  generateStructuredResult<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options?: GenerateOptions,
  ): Promise<Generation<SchemaOutput<S>> | ProviderFailure>;
  /** `generateText`, with the token usage of the call next to the text. Fails as it does. */
  generateTextResult(prompt: string, options?: GenerateOptions): Promise<Generation<string> | ProviderFailure>;
};
