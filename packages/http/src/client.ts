/**
 * A typed fetch client built from the same route contracts the server binds.
 *
 * ```ts
 * import { createClient } from '@arki/http/client';
 * import { getOrder, listOrders } from './contracts';
 *
 * const orders = createClient({ getOrder, listOrders }, { baseUrl: 'https://api.example.com' });
 * const order = await orders.getOrder({ params: { id: 'o42' } });
 * ```
 *
 * Inputs are typed from the contract and encoded the way the server decodes
 * them: params, headers, query and body run through their schema in the
 * encode direction (so a codec turns a `Date` into its ISO string), and path
 * params are URL-escaped. A missing optional path segment is dropped.
 *
 * The result follows the contract: a status listed in `responses` decodes
 * with that schema, a success decodes with `output`, a route without `output`
 * resolves `undefined` (it answers 204), and a `raw()` route resolves the
 * `Response`. A failed call whose code is one of the contract's `failures`
 * resolves to that failure, revived and its data checked with the
 * definition's schema; any other failed call throws {@link HttpError} with
 * the server's error code.
 *
 * Uses only `fetch` — no Node APIs — so it runs in browsers, React Native,
 * Deno, Bun and Node. This is why it lives at its own subpath: the root entry
 * pulls in the server engine.
 */

import { z } from 'zod';

import { revive } from '@arki/failure';

import type { Decoded } from './bundle.js';
import type { ParamsOf, PathParams, ResponseSchemas, RouteContract, RouteDef, RouteFailure } from './contract.js';
import { formatIssues, HTTP_ERROR_CODES, HttpError } from './error.js';
import type { RawOutput } from './raw.js';
import { isRawOutput } from './raw.js';

/** Any JSON route contract — what {@link createClient} accepts. */
type AnyRoute = RouteContract<string, RouteDef<string>>;

/** Nothing to pass: the identity for the input intersections below. */
type NoInput = Record<never, never>;

type ParamsInput<TPath extends string, TParams> = [PathParams<TPath>] extends [never]
  ? NoInput
  : NoInput extends TParams
    ? { readonly params?: TParams }
    : { readonly params: TParams };

/** An input the caller may leave out when every field of it is optional. */
type OptionalWhenEmpty<TName extends string, TValue> = [TValue] extends [undefined]
  ? NoInput
  : NoInput extends TValue
    ? Partial<Readonly<Record<TName, TValue>>>
    : Readonly<Record<TName, TValue>>;

type BodyInput<TBody> = [TBody] extends [undefined] ? NoInput : { readonly body: TBody };

/**
 * What one client call takes: `params` when the path has parameters, and
 * `query`, `headers` and `body` when the contract declares them. Each is the
 * schema's output type — the same values the server handler receives.
 */
export type ClientInput<TRoute> = TRoute extends { readonly path: infer TPath extends string }
  ? Flatten<
      ParamsInput<TPath, Decoded<TRoute, 'params', ParamsOf<TPath>>> &
        OptionalWhenEmpty<'query', Decoded<TRoute, 'query', undefined>> &
        OptionalWhenEmpty<'headers', Decoded<TRoute, 'headers', undefined>> &
        BodyInput<Decoded<TRoute, 'body', undefined>>
    >
  : never;

/** Merge an intersection into one object type, so editors show it plainly. */
type Flatten<T> = { [K in keyof T]: T[K] };

type SuccessOf<TRoute> = TRoute extends { readonly output: infer TOutput }
  ? TOutput extends z.ZodType
    ? z.output<TOutput>
    : never
  : undefined;

type StatusBodies<TRoute> = TRoute extends { readonly responses: infer TResponses extends ResponseSchemas }
  ? { [S in keyof TResponses & number]: z.output<TResponses[S]> }[keyof TResponses & number]
  : never;

/**
 * What one client call resolves to: the output schema's output type
 * (`undefined` when the contract has no output, `Response` for `raw()`),
 * the body of a status listed in `responses`, or one of the failures the
 * contract lists.
 */
export type ClientOutput<TRoute> = TRoute extends { readonly output: RawOutput }
  ? Response | RouteFailure<TRoute>
  : SuccessOf<TRoute> | StatusBodies<TRoute> | RouteFailure<TRoute>;

/** Per-call options: an abort signal and extra request headers. */
type CallInit = {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
};

/** One typed call. The input argument may be left out when nothing is required. */
export type ClientCall<TRoute> =
  NoInput extends ClientInput<TRoute>
    ? (input?: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>>
    : (input: ClientInput<TRoute>, init?: CallInit) => Promise<ClientOutput<TRoute>>;

/**
 * What the client needs from a retry policy: an `@arki/resilience` policy fits. A policy with a
 * fallback does not, because its result could be the fallback instead of a response.
 */
export type ClientPolicy = {
  execute<T>(fn: (context: { readonly signal: AbortSignal }) => PromiseLike<T> | T, signal?: AbortSignal): Promise<T>;
};

/** One attempt's outcome, as `retryOn` sees it: the response, or the error `fetch` threw. */
export type RetryOutcome = {
  readonly method: string;
  /** True for GET, HEAD, OPTIONS, PUT and DELETE, and for any request with an `idempotency-key` header. */
  readonly repeatable: boolean;
} & ({ readonly response: Response; readonly error?: never } | { readonly error: unknown; readonly response?: never });

/** Options for {@link createClient}. */
export type ClientOptions = {
  /** Origin plus any path prefix, e.g. `https://api.example.com/v1`. A relative prefix (`/api`) works where fetch allows it. */
  readonly baseUrl: string;
  /**
   * The fetch to use. Defaults to the global `fetch`. Wrap it to add auth headers. On a server that
   * calls URLs it does not fully control, pass `publicFetch()` from `@arki/http/public-fetch`.
   */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * Gives up once the response has not arrived within this many milliseconds, retries included,
   * and throws `HttpError` 408 (`ARKI_HTTP_E408`). Reading the body is not timed.
   */
  readonly timeoutMs?: number;
  /**
   * Runs each attempt, so it can retry and back off. Only an outcome `retryOn` accepts is retried;
   * any other answer or error leaves the policy at once, whatever the policy itself would retry.
   */
  readonly policy?: ClientPolicy;
  /** Which outcomes `policy` retries. Default {@link retryTransient}. */
  readonly retryOn?: (outcome: RetryOutcome) => boolean;
};

const RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);
const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * The default `retryOn`: a network failure (`fetch` throws a `TypeError`) or a 408, 429, 502, 503
 * or 504, and only on a request that is safe to send twice. A POST without an idempotency key is
 * never retried: the first try may have done the work before the answer was lost.
 */
export function retryTransient(outcome: RetryOutcome): boolean {
  if (!outcome.repeatable) return false;
  return outcome.response === undefined
    ? outcome.error instanceof TypeError
    : RETRY_STATUSES.has(outcome.response.status);
}

/** Build one typed call from a single contract. */
export function createClient<TRoute extends AnyRoute>(contract: TRoute, options: ClientOptions): ClientCall<TRoute>;
/** Build one typed call per contract, under the same keys. */
export function createClient<TRoutes extends Readonly<Record<string, AnyRoute>>>(
  contracts: TRoutes,
  options: ClientOptions,
): { readonly [K in keyof TRoutes]: ClientCall<TRoutes[K]> };
// The implementation works on erased contracts (`ErasedCall`); the overloads
// above carry the inferred types. TypeScript cannot relate a conditional type
// over a generic contract to the erased call, so the implementation's return
// is declared `unknown` — the same erasure boundary the engine uses.
export function createClient(
  contractOrContracts: AnyRoute | Readonly<Record<string, AnyRoute>>,
  options: ClientOptions,
): unknown {
  // Read once into a local: calling `fetch` as a method of another object
  // throws "Illegal invocation" in browsers.
  const transport: Transport = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs,
    policy: options.policy,
    retryOn: options.retryOn ?? retryTransient,
  };
  if (isRoute(contractOrContracts)) return buildCall(contractOrContracts, transport);
  const calls: Record<string, ErasedCall> = {};
  for (const [key, contract] of Object.entries(contractOrContracts)) {
    calls[key] = buildCall(contract, transport);
  }
  return calls;
}

type ErasedInput = {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
};

/** A call with its contract's generics erased; the overloads restore them. */
type ErasedCall = (input?: ErasedInput, init?: CallInit) => Promise<unknown>;

type Transport = {
  readonly baseUrl: string;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs: number | undefined;
  readonly policy: ClientPolicy | undefined;
  readonly retryOn: (outcome: RetryOutcome) => boolean;
};

function isRoute(value: AnyRoute | Readonly<Record<string, AnyRoute>>): value is AnyRoute {
  return value.kind === 'http' && typeof value.path === 'string';
}

function buildCall(contract: AnyRoute, transport: Transport): ErasedCall {
  return (input, init) => call(contract, transport, input ?? {}, init ?? {});
}

async function call(contract: AnyRoute, transport: Transport, input: ErasedInput, init: CallInit): Promise<unknown> {
  // The input may leave out `params` and `headers` when every field is optional.
  const params =
    contract.params === undefined ? input.params : encodeWith(contract.params, input.params ?? {}, 'params');
  let url = transport.baseUrl + fillPath(contract.path, toStrings('params', params));
  if (contract.query !== undefined && input.query !== undefined) {
    const search = toSearch(encodeWith(contract.query, input.query, 'query'));
    if (search !== '') url += `?${search}`;
  }

  // A plain record, not `Headers`: Hermes has no `Headers` unless a polyfill adds it.
  const declared =
    contract.headers === undefined ? {} : toStrings('headers', encodeWith(contract.headers, input.headers ?? {}, 'headers'));
  const headers: Record<string, string> = { ...declared, ...init.headers };
  const request: RequestInit = { method: contract.method, headers };
  if (contract.body !== undefined) {
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    request.body = JSON.stringify(encodeWith(contract.body, input.body, 'body'));
  }

  const repeatable = REPEATABLE_METHODS.has(contract.method) || hasHeader(headers, 'idempotency-key');
  // The route template, not the URL: the URL may carry tokens, and this text can reach a log or the wire.
  const response = await send(transport, url, request, init.signal, repeatable, `${contract.method} ${contract.path}`);
  // A status the contract lists answers with that schema's body, ok or not.
  const listed = isRawOutput(contract.output) ? undefined : contract.responses?.[response.status];
  if (listed !== undefined) return decodeBody(contract, listed, response);
  if (!response.ok) return await toListedFailure(contract, response);
  if (isRawOutput(contract.output)) return response;
  if (contract.output === undefined || response.status === 204) return undefined;
  return decodeBody(contract, contract.output, response);
}

/** A response `retryOn` accepted, thrown so the policy retries. Unwrapped when the policy gives up. */
class RetryableResponse extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super(`retryable status ${response.status}`);
    this.response = response;
  }
}

type Attempt = { readonly response: Response } | { readonly error: unknown };

/** Send once, or through the policy; either way under the deadline. */
async function send(
  transport: Transport,
  url: string,
  request: RequestInit,
  signal: AbortSignal | undefined,
  repeatable: boolean,
  routeName: string,
): Promise<Response> {
  const { policy, retryOn } = transport;
  const method = request.method ?? 'GET';
  const deadline = withDeadline(signal, transport.timeoutMs, routeName);
  try {
    if (policy === undefined) return await transport.fetch(url, withSignal(request, deadline.signal));
    let previous: Response | undefined;
    const attempt = async (context: { readonly signal: AbortSignal }): Promise<Attempt> => {
      // A retried response is dropped unread: free its connection before the next try.
      void previous?.body?.cancel().catch(() => null);
      let response: Response;
      try {
        response = await transport.fetch(url, { ...request, signal: context.signal });
      } catch (error) {
        // Thrown back into the policy only when it may retry; anything else leaves it at once.
        if (retryOn({ method, repeatable, error })) throw error;
        return { error };
      }
      if (!retryOn({ method, repeatable, response })) return { response };
      previous = response;
      throw new RetryableResponse(response);
    };
    let outcome: Attempt;
    try {
      outcome = await policy.execute(attempt, deadline.signal);
    } catch (error) {
      if (error instanceof RetryableResponse) return error.response;
      throw error;
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  } catch (error) {
    // A timeout or the caller's abort may surface as the policy's own cancel error: report the cause.
    if (deadline.signal?.aborted === true && deadline.signal.reason !== undefined) throw deadline.signal.reason;
    throw error;
  } finally {
    deadline.clear();
  }
}

function withSignal(request: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? request : { ...request, signal };
}

type Deadline = { readonly signal: AbortSignal | undefined; readonly clear: () => void };

/** The caller's signal, plus an abort after `timeoutMs` with `HttpError` 408. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number | undefined, what: string): Deadline {
  if (timeoutMs === undefined) return { signal, clear: () => null };
  const controller = new AbortController();
  const follow = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) follow();
  else signal?.addEventListener('abort', follow, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      new HttpError(408, HTTP_ERROR_CODES.requestTimeout, `${what} got no response within ${timeoutMs} ms`),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', follow);
    },
  };
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/** `/orders/:id` + `{ id: 'a b' }` → `/orders/a%20b`. A missing optional segment is dropped. */
function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  const filled = path
    .split('/')
    .map(segment => fillSegment(segment, params))
    .filter((segment): segment is string => segment !== undefined);
  return filled.join('/') || '/';
}

function fillSegment(segment: string, params: Readonly<Record<string, string>>): string | undefined {
  if (!segment.startsWith(':')) return segment;
  const optional = segment.endsWith('?');
  const name = segment.slice(1, optional ? -1 : undefined);
  const value = params[name];
  if (value === undefined) {
    if (optional) return undefined;
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `path parameter "${name}" is missing`);
  }
  // encodeURIComponent keeps "." and "..", and fetch resolves them: `..` in
  // `/orders/:id/cancel` would call `/cancel`, another endpoint, with the
  // user's cookies. An empty value collapses the segment the same way.
  if (value === '' || value === '.' || value === '..') {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `path parameter "${name}" must not be empty, "." or ".."`, {
      remediation: 'A path parameter fills exactly one segment; pass a real id.',
    });
  }
  return encodeURIComponent(value);
}

/** Run a schema in the encode direction; a failure is the 400 the server would answer. */
function encodeWith(schema: z.ZodType, value: unknown, where: 'params' | 'headers' | 'query' | 'body'): unknown {
  try {
    return schema.encode(value);
  } catch (error) {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `${where} validation failed: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/**
 * The server reads each param, header and query key as one string, so every
 * encoded field must be a string, number, boolean or bigint. `undefined`
 * fields are left out.
 */
function toStrings(where: 'params' | 'headers' | 'query', encoded: unknown): Record<string, string> {
  if (encoded === undefined) return {};
  if (typeof encoded !== 'object' || encoded === null) {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `${where} validation failed: it must encode to an object`);
  }
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(encoded)) {
    if (value !== undefined) strings[key] = scalarString(where, key, value);
  }
  return strings;
}

function toSearch(encoded: unknown): string {
  return Object.entries(toStrings('query', encoded))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function scalarString(where: string, key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new HttpError(
    400,
    HTTP_ERROR_CODES.badRequest,
    `${where} validation failed: ${key}: must encode to a string, number or boolean`,
    { remediation: `Give the ${where} field a codec that encodes to a string.` },
  );
}

async function decodeBody(contract: AnyRoute, output: z.ZodType, response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new HttpError(500, HTTP_ERROR_CODES.internal, `response for "${contract.id}" is not valid JSON`, {
      cause: error,
    });
  }
  try {
    return output.parse(body);
  } catch (error) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `response for "${contract.id}" violates the contract's output schema: ${messageOf(error)}`,
      {
        cause: error,
        remediation: 'The client and server disagree on the contract. Deploy the same contract version to both.',
      },
    );
  }
}

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    remediation: z.string().optional(),
    docsUrl: z.string().optional(),
    data: z.unknown().optional(),
  }),
});

/**
 * A non-2xx response as the failure it stands for, when its code is one the
 * contract lists. Anything else throws {@link HttpError}, keeping the
 * server's code when it sent the envelope.
 */
async function toListedFailure(contract: AnyRoute, response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    const failure = reviveListed(contract, envelope.data.error);
    if (failure !== undefined) return failure;
    const { code, message, remediation, docsUrl } = envelope.data.error;
    throw new HttpError(response.status, code, message, {
      ...(remediation === undefined ? {} : { remediation }),
      ...(docsUrl === undefined ? {} : { docsUrl }),
    });
  }
  throw new HttpError(
    response.status,
    codeForStatus(response.status),
    `${contract.method} ${contract.path} answered ${response.status} without an error envelope`,
  );
}

/** The listed failure the envelope's code names, its data checked by `revive`; `undefined` when not listed. */
function reviveListed(contract: AnyRoute, error: { readonly code: string; readonly data?: unknown }): unknown {
  if (contract.failures === undefined) return undefined;
  try {
    return revive(error, contract.failures);
  } catch (error_) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `failure "${error.code}" from "${contract.id}" carries data its definition rejects: ${messageOf(error_)}`,
      {
        cause: error_,
        remediation:
          'The client and server disagree on the failure definition. Deploy the same contract version to both.',
      },
    );
  }
}

/** The wire code a status maps to when the response carried no envelope (a proxy, a gateway). */
function codeForStatus(status: number): string {
  if (status === 400) return HTTP_ERROR_CODES.badRequest;
  if (status === 401) return HTTP_ERROR_CODES.unauthorized;
  if (status === 403) return HTTP_ERROR_CODES.forbidden;
  if (status === 404) return HTTP_ERROR_CODES.notFound;
  return HTTP_ERROR_CODES.internal;
}

function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) return formatIssues(error);
  return error instanceof Error ? error.message : String(error);
}
