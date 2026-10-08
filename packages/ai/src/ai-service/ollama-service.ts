/**
 * Ollama Service — local-first LLM provider for `@arki/ai`.
 *
 * Targets a locally-running Ollama daemon (default `http://localhost:11434`)
 * via the `ai-sdk-ollama` AI SDK v6 provider — *not* the OpenAI-compat
 * shim and not raw `ollama-js`. The choice gives us, in one swap:
 *
 *   1. **Constrained decoding via Ollama's native `format` param.** The
 *      provider feeds the JSON Schema (derived from the Zod schema by
 *      AI SDK's `Output.object()`) directly into Ollama's grammar
 *      engine. Result: every emitted token is a valid prefix of the
 *      schema.
 *   2. **Cascade JSON repair, automatic.** When constrained decoding
 *      produces output that nonetheless fails Zod parsing (a refinement
 *      like `.min(5)` on an array, a stray trailing comma from a
 *      smaller model, etc.), `ai-sdk-ollama`'s enhanced `generateText`
 *      / `streamText` runs `jsonrepair` then an Ollama-specific
 *      fallback transparently — controlled by `enableTextRepair`
 *      (default `true`).
 *   3. **v6-idiomatic `generateText({ output: Output.object(...) })`.**
 *      Same SDK surface as our `OpenAIService` and `AnthropicService`,
 *      so the three providers remain interchangeable through the
 *      `DiscoveryLlmAdapter` boundary. The deprecated
 *      `generateObject` / `streamObject` paths are NOT used — they emit
 *      deprecation warnings under `ai@^6` and are scheduled for
 *      removal.
 *
 * No API key, no egress, no per-call cost. Per `@arki/ai/AGENTS.md`
 * LAW 1, this is the **default** LLM provider in Arki — cloud
 * providers are explicit fall-throughs.
 */

import { createOllama, generateText, streamText } from 'ai-sdk-ollama';
import { Output } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from '@arki/contracts';

import { debugService } from '../debug.ts';
import { GenerationError, getErrorMessage } from '../errors';

type ChatMessage = ModelMessage;

export type OllamaServiceConfig = {
  /** Disable extended reasoning for latency-sensitive structured extraction. */
  think?: boolean;
  /** Model tag, e.g. `gemma4`, `qwen3.6`, `llama3.2-vision:11b`. */
  model?: string;
  /**
   * Base URL of the Ollama daemon. Defaults to `OLLAMA_HOST` env, then
   * `OLLAMA_BASE_URL` env (with `/v1` suffix stripped if present), then
   * `http://localhost:11434`.
   */
  host?: string;
  /** Default sampling temperature (0–2). */
  temperature?: number;
  /** Per-call retry budget. Local models rarely need >1 retry. */
  maxRetries?: number;
  /**
   * How long the daemon should keep the model resident in memory
   * after a call completes. Forwarded as `keep_alive` to the Ollama
   * provider's `chat` settings.
   *
   * Format accepts duration strings like `'5m'`, `'20m'`, `'1h'`,
   * or `0` to unload immediately. Defaults to Ollama's built-in
   * 5-minute idle unload.
   *
   * Why a caller might set this: pipelines that issue many vision
   * calls back-to-back pay a 10-20s reload cost every time the model
   * unloads between calls. A longer keep-alive amortizes that cost.
   */
  keepAlive?: string | number;
};

export type OllamaGenerationOptions = {
  temperature?: number;
  maxRetries?: number;
  systemPrompt?: string;
  /**
   * Per-token streaming callback. When provided, the service uses
   * `streamText` so each delta token (the raw text the model emits
   * mid-generation) is forwarded to this callback. The structured
   * output is still parsed + Zod-validated at the end of the stream,
   * so the caller gets the same `T` return value as the non-streaming
   * path — `onToken` is purely a side-channel for observability
   * (debug panes, smoke tests, log files, …).
   *
   * NB: with constrained decoding, partial output is always a valid
   * JSON prefix — useful when you want to render structured output
   * progressively. For *parsed* partial objects (DeepPartial<T> as
   * the model fills fields in), expose `partialOutputStream` from the
   * underlying `streamText` result instead.
   */
  onToken?: (chunk: string) => void;
  /**
   * Abort signal forwarded to the AI SDK (`abortSignal`). When the
   * signal aborts, the streaming/non-streaming request is cancelled
   * AND the upstream Ollama daemon stops generating — without this,
   * a cockatiel timeout would hand control back to the caller while
   * the model kept burning cycles on a now-orphaned response.
   */
  signal?: AbortSignal;
};

/**
 * Streaming options for {@link OllamaService.streamConversation}. Extends the
 * base generation options with lifecycle callbacks that mirror
 * `OpenAIService`'s stream surface, so the three providers stay interchangeable
 * for streaming callers (e.g. a chat copilot endpoint).
 */
export type OllamaStreamOptions = OllamaGenerationOptions & {
  onStart?: () => void;
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
};

const DEFAULT_MODEL = 'gemma4';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_RETRIES = 1;

/**
 * Resolve the Ollama daemon host with sensible fallbacks.
 *
 * `OLLAMA_BASE_URL` is what the discovery feature uses, plus many
 * `@ai-sdk/openai`-against-`/v1` setups. The `ai-sdk-ollama` provider
 * expects a host without the `/v1` suffix, so we strip it when present.
 * That way operators can keep one env var across both call paths.
 */
function resolveHost(explicit?: string): string {
  const raw =
    explicit ?? process.env['OLLAMA_HOST'] ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  return raw.replace(/\/v1\/?$/, '');
}

/**
 * Local-first LLM service. Mirrors `OpenAIService` / `AnthropicService`
 * for the `generateStructured*` methods — drop-in compatible for callers
 * typed against the `DiscoveryLlmAdapter` boundary.
 */
export class OllamaService {
  private readonly provider: ReturnType<typeof createOllama>;
  private readonly model: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxRetries: number;
  private readonly keepAlive: string | number | undefined;
  private readonly think: boolean | undefined;

  constructor(config: OllamaServiceConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.defaultTemperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.defaultMaxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.keepAlive = config.keepAlive;
    this.think = config.think;

    const host = resolveHost(config.host);
    this.provider = createOllama({ baseURL: host });

    debugService(
      '[Ollama] Service initialized (model: %s, host: %s, temperature: %d, maxRetries: %d, keepAlive: %s)',
      this.model,
      host,
      this.defaultTemperature,
      this.defaultMaxRetries,
      this.keepAlive ?? 'default',
    );
  }

  /**
   * Build the ai-sdk-ollama LanguageModel for this call. Threads
   * `keep_alive` into the chat settings so the daemon doesn't unload
   * the model between calls (default Ollama unload is 5 min idle).
   */
  private buildModel() {
    return this.provider(this.model, {
      ...(this.keepAlive !== undefined ? { keep_alive: this.keepAlive } : {}),
      ...(this.think !== undefined ? { think: this.think } : {}),
    });
  }

  /**
   * Single-prompt structured generation. Convenience wrapper around
   * {@link generateStructuredDataFromMessages}.
   */
  async generateStructuredData<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: OllamaGenerationOptions = {},
  ): Promise<T> {
    return this.generateStructuredDataFromMessages(
      [{ role: 'user', content: prompt }],
      schema,
      options,
    );
  }

  /**
   * Multi-message structured generation. Uses AI SDK v6's
   * `generateText({ output: Output.object({ schema }) })` — the
   * stable replacement for the deprecated `generateObject`. Cascade
   * JSON repair is auto-applied by `ai-sdk-ollama`'s enhanced
   * functions (`enableTextRepair: true` by default).
   */
  async generateStructuredDataFromMessages<T>(
    messages: ChatMessage[],
    schema: z.ZodSchema<T>,
    options: OllamaGenerationOptions = {},
  ): Promise<T> {
    const temperature = options.temperature ?? this.defaultTemperature;
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    const output = Output.object({ schema: schema as z.ZodSchema });

    debugService(
      '[Ollama] generateText (model=%s, messages=%d, temperature=%d, stream=%s)',
      this.model,
      messages.length,
      temperature,
      !!options.onToken,
    );

    try {
      // Streaming path — emit token deltas to `onToken` as the model
      // generates, then await the assembled + Zod-validated output.
      if (options.onToken) {
        const result = await streamText({
          model: this.buildModel(),
          instructions: options.systemPrompt,
          messages,
          output,
          temperature,
          maxRetries,
          abortSignal: options.signal,
        });

        for await (const chunk of result.textStream) {
          options.onToken(chunk);
        }

        const obj = await result.output;
        debugService('[Ollama] Structured data generated successfully (streamed)');
        return obj as T;
      }

      // Non-streaming path — single round-trip, full structured output
      // arrives in `result.output`.
      const result = await generateText({
        model: this.buildModel(),
        instructions: options.systemPrompt,
        messages,
        output,
        temperature,
        maxRetries,
        abortSignal: options.signal,
      });

      debugService('[Ollama] Structured data generated successfully');
      return result.output as T;
    } catch (error) {
      debugService(
        '[Ollama] Structured generation failed (model=%s): %s',
        this.model,
        getErrorMessage(error),
      );
      throw new GenerationError(
        `Failed to generate structured data via Ollama (${this.model}): ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Plain-text multi-turn generation. Sends the full conversation history to
   * the model and returns its natural-language reply *without* forcing a JSON
   * schema — unlike {@link generateStructuredDataFromMessages}, this preserves
   * the model's own voice and formatting. The anti-leak / role system prompt is
   * threaded via `options.systemPrompt`.
   */
  async generateConversation(
    messages: ChatMessage[],
    options: OllamaGenerationOptions = {},
  ): Promise<string> {
    const temperature = options.temperature ?? this.defaultTemperature;
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;

    debugService(
      '[Ollama] generateConversation (model=%s, messages=%d, temperature=%d)',
      this.model,
      messages.length,
      temperature,
    );

    try {
      const result = await generateText({
        model: this.buildModel(),
        instructions: options.systemPrompt,
        messages,
        temperature,
        maxRetries,
        abortSignal: options.signal,
      });

      debugService('[Ollama] Conversation response generated (length: %d)', result.text.length);
      return result.text;
    } catch (error) {
      debugService(
        '[Ollama] Conversation generation failed (model=%s): %s',
        this.model,
        getErrorMessage(error),
      );
      throw new GenerationError(
        `Failed to generate conversation via Ollama (${this.model}): ${getErrorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Streaming variant of {@link generateConversation}. Yields each text delta as
   * the model emits it (for a typing-indicator UX) and invokes the optional
   * lifecycle callbacks. The abort signal cancels both the stream and the
   * upstream Ollama generation.
   */
  async *streamConversation(
    messages: ChatMessage[],
    options: OllamaStreamOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const temperature = options.temperature ?? this.defaultTemperature;
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;

    debugService(
      '[Ollama] streamConversation (model=%s, messages=%d, temperature=%d)',
      this.model,
      messages.length,
      temperature,
    );

    try {
      options.onStart?.();

      const result = await streamText({
        model: this.buildModel(),
        instructions: options.systemPrompt,
        messages,
        temperature,
        maxRetries,
        abortSignal: options.signal,
      });

      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
        options.onToken?.(chunk);
        yield chunk;
      }

      options.onComplete?.(fullText);
    } catch (error) {
      options.onError?.(error as Error);
      debugService(
        '[Ollama] Stream conversation failed (model=%s): %s',
        this.model,
        getErrorMessage(error),
      );
      throw new GenerationError(
        `Failed to stream conversation via Ollama (${this.model}): ${getErrorMessage(error)}`,
        error,
      );
    }
  }
}
