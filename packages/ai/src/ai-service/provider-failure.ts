/**
 * The one boundary between AI SDK throws and `@arki/ai` failures. Every provider call (the
 * adapter, the provider services, the router, the tool-loop runtimes) maps what the SDK threw or
 * streamed through `providerFailure`, checks the finish reason through `finishFailure`, and reads
 * streams through `streamText` parts with `readTextParts`, so the same SDK error always becomes the
 * same returned failure.
 */
import type { FinishReason, TextStreamPart, ToolSet } from 'ai';
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
  StreamProviderError,
  TypeValidationError,
} from 'ai';
import { OllamaError } from 'ai-sdk-ollama';

import { z } from '@arki/contracts';
import { UnexpectedDefect } from '@arki/failure';
import { is } from '@arki/schema';

import type { ProviderFailure } from '../failures.js';
import { debugService } from '../debug.js';
import {
  Cancelled,
  ContentFiltered,
  IncompleteGeneration,
  InvalidOutput,
  ProviderFailed,
  ProviderUnauthorized,
  RateLimited,
} from '../failures.js';

/** Which call failed: the names a failure carries, and the caller's signal (an abort is `Cancelled`). */
export type ProviderCall = {
  readonly provider: string;
  readonly model: string;
  readonly signal?: AbortSignal | undefined;
};

/**
 * The wait a 429 asked for, from `retry-after-ms` (milliseconds) or `retry-after` (seconds or an
 * HTTP date). Undefined when neither header is there or readable.
 */
export function retryAfterMs(headers: Readonly<Record<string, string>> | undefined, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const ms = Number(lower.get('retry-after-ms'));
  if (lower.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const after = lower.get('retry-after');
  if (after === undefined || after.trim() === '') return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The failure for an HTTP status the provider answered with. */
function statusFailure(
  status: number | undefined,
  headers: Readonly<Record<string, string>> | undefined,
  call: ProviderCall,
  cause: unknown,
): ProviderFailure {
  const names = { provider: call.provider, model: call.model };
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return RateLimited(wait === undefined ? {} : { retryAfterMs: wait }, { cause });
  }
  if (status === 401 || status === 403) return ProviderUnauthorized({ ...names, status }, { cause });
  return ProviderFailed(status === undefined ? names : { ...names, status }, { cause });
}

/** The HTTP error of the `ollama` client, which `ai-sdk-ollama` wraps in an `OllamaError` cause. */
const ollamaResponseError = z.object({ status_code: z.number() });

/** An abort raised by `fetch` or the SDK: a DOM `AbortError`, or the `TimeoutError` of `AbortSignal.timeout`. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Map anything a provider call threw, or an `error` part it streamed, to a returned failure.
 * A rate limit keeps its Retry-After, 401/403 is `ProviderUnauthorized`, a bad answer is
 * `InvalidOutput`, a server or network failure is `ProviderFailed`, an abort is `Cancelled`.
 * Anything else is a bug, returned as `UnexpectedDefect` and logged.
 */
export function providerFailure(error: unknown, call: ProviderCall): ProviderFailure {
  if (call.signal?.aborted || isAbort(error)) return Cancelled({ cause: error });
  // The SDK retries retryable errors itself and then throws a RetryError around the last one.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const names = { provider: call.provider, model: call.model };
  if (cause !== error && isAbort(cause)) return Cancelled({ cause: error });
  if (APICallError.isInstance(cause)) return statusFailure(cause.statusCode, cause.responseHeaders, call, error);
  if (StreamProviderError.isInstance(cause)) return statusFailure(cause.statusCode, undefined, call, error);
  if (LoadAPIKeyError.isInstance(cause)) return ProviderUnauthorized(names, { cause: error });
  // ai-sdk-ollama wraps every client throw: an HTTP answer carries `status_code`, anything else
  // (connection refused, a body that stopped) means the local server could not answer.
  if (OllamaError.isOllamaError(cause)) {
    if (isAbort(cause.cause)) return Cancelled({ cause: error });
    const status = is(cause.cause, ollamaResponseError) ? cause.cause.status_code : undefined;
    return statusFailure(status, undefined, call, error);
  }
  if (NoObjectGeneratedError.isInstance(cause)) {
    const finished = cause.finishReason === undefined ? undefined : finishFailure(cause.finishReason, call);
    return finished ?? InvalidOutput({ ...names, reason: cause.message }, { cause: error });
  }
  if (
    NoOutputGeneratedError.isInstance(cause) ||
    NoContentGeneratedError.isInstance(cause) ||
    JSONParseError.isInstance(cause) ||
    TypeValidationError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    EmptyResponseBodyError.isInstance(cause)
  ) {
    return InvalidOutput({ ...names, reason: cause.message }, { cause: error });
  }
  debugService.error('Unexpected throw from {provider}/{model}: {errorName}', {
    ...names,
    errorName: error instanceof Error ? error.name : typeof error,
  });
  return UnexpectedDefect({ cause: error });
}

/**
 * The failure a finish reason means, or undefined for `stop`. `content-filter` is
 * `ContentFiltered`, `error` is `ProviderFailed`, and `length`, `tool-calls` and `other` are
 * `IncompleteGeneration`: the text that came back is not the whole answer.
 */
export function finishFailure(finishReason: FinishReason, call: ProviderCall): ProviderFailure | undefined {
  const names = { provider: call.provider, model: call.model };
  if (finishReason === 'stop') return undefined;
  if (finishReason === 'content-filter') return ContentFiltered(names);
  if (finishReason === 'error') return ProviderFailed(names);
  return IncompleteGeneration({ ...names, finishReason });
}

/**
 * The text of a `streamText` `fullStream`, chunk by chunk. An `error` part, an `abort` part, a
 * finish other than `stop`, or a stream that ends with no finish yields one failure and ends the
 * stream: a stream that stops early never looks complete.
 */
export async function* readTextParts(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  call: ProviderCall,
): AsyncGenerator<string | ProviderFailure, void, unknown> {
  try {
    for await (const part of parts) {
      switch (part.type) {
        case 'text-delta': {
          yield part.text;
          break;
        }
        case 'error': {
          yield providerFailure(part.error, call);
          return;
        }
        case 'abort': {
          yield Cancelled();
          return;
        }
        case 'finish': {
          const failure = finishFailure(part.finishReason, call);
          if (failure) yield failure;
          return;
        }
        // Other parts (reasoning, tool calls, metadata) carry no answer text.
      }
    }
  } catch (error) {
    yield providerFailure(error, call);
    return;
  }
  yield call.signal?.aborted ? Cancelled() : IncompleteGeneration({ provider: call.provider, model: call.model, finishReason: 'none' });
}
