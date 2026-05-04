/**
 * Common LLM Provider Interface
 *
 * Defines a unified interface for interacting with different LLM providers
 * (OpenAI, Anthropic, Groq, Google, Mistral, OpenRouter) through the Vercel AI SDK.
 */

/**
 * Message format for conversation-based interactions
 */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

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
}

/**
 * Options specific to streaming generation
 */
export type StreamOptions = {
  /** Callback for each chunk received */
  onChunk?: (chunk: string) => void;
  /** Callback when stream completes */
  onComplete?: (fullText: string) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
} & GenerateOptions

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
}

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
}

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
}

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
   * @returns Generated text
   */
  generateText(prompt: string, options?: GenerateOptions): Promise<string>;

  /**
   * Generate text from a conversation history
   *
   * @param messages - Array of conversation messages
   * @param options - Generation options
   * @returns Generated response text
   */
  generateConversation(
    messages: Message[],
    options?: GenerateOptions,
  ): Promise<string>;

  /**
   * Stream text generation from a single prompt
   *
   * @param prompt - The input prompt
   * @param options - Stream options
   * @yields Text chunks as they're generated
   */
  streamText(
    prompt: string,
    options?: StreamOptions,
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Stream text generation from a conversation history
   *
   * @param messages - Array of conversation messages
   * @param options - Stream options
   * @yields Text chunks as they're generated
   */
  streamConversation(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Check if the provider is available (has API key configured)
   *
   * @returns Whether the provider can be used
   */
  isAvailable(): boolean;
}

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
   * Output is validated against the supplied Zod schema.
   */
  generateStructuredData<T>(
    prompt: string,
    schema: import('zod').ZodSchema<T>,
    options?: GenerateOptions,
  ): Promise<T>;

  /**
   * Generate a structured object from a conversation history.
   * Useful for multi-turn interactions where context matters.
   */
  generateStructuredDataFromMessages<T>(
    messages: Message[],
    schema: import('zod').ZodSchema<T>,
    options?: GenerateOptions,
  ): Promise<T>;

  /**
   * Generate plain text from a single prompt.
   */
  generateText(prompt: string, options?: GenerateOptions): Promise<string>;

  /**
   * Stream a conversational response, yielding text chunks as they arrive.
   * Used for real-time copilot streaming endpoints.
   */
  streamConversation(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncGenerator<string, void, unknown>;
};
