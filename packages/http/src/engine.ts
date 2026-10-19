/**
 * The request engine — builds one fetch handler from a list of bundles.
 *
 * Hono does the routing internally; no Hono type appears in the public
 * API, so the engine stays a swappable implementation detail. The route
 * table order is bundle order then binding order — declaration order,
 * deterministically, per DOT principle 3.
 */

import { Hono } from 'hono';

import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, isFailure, serialize } from '@arki/failure';
import { formatIssues } from '@arki/schema';

import type { MountBinding, RouteBinding, RouteBundle, RpcBinding } from './bundle.js';
import type { ContractLike, ErasedInput } from './contract.js';
import type { BaseRequestCtx } from './derive.js';
import type { Field, Job, Ran, Where, Wire } from './wire.js';
import { isReply } from './bundle.js';
import { runWithRequestContext } from './context.js';
import { errorResponse, HTTP_ERROR_CODES, HttpConfigError, HttpError, toErrorResponse } from './error.js';
import { openApiPaths } from './path.js';
import { isRawOutput } from './raw.js';
import { sseResponse } from './sse.js';
import { decoderOf, encoderOf, fieldParts, issuesOf, missingField, runJobs, runSchema } from './wire.js';

type MaybePromise<T> = T | Promise<T>;

/** `next(value)`, after `value` settles when it is a promise. Sync in, sync out. */
function andThen<T, U>(value: MaybePromise<T>, next: (value: T) => MaybePromise<U>): MaybePromise<U> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/** A built engine: the composed fetch handler plus its route inventory. */
export type Engine = {
  readonly fetch: (req: Request) => Promise<Response>;
  /** Contract ids + mount ids, in registration order. */
  readonly routeIds: readonly string[];
};

/**
 * Compose bundles into a single fetch handler. Throws
 * `ARKI_HTTP_E002`/`E006` on route collisions and malformed mounts —
 * callers (the `http()` plugin's `boot`) let these bubble as boot failures.
 */
export function buildEngine(bundles: readonly RouteBundle[]): Engine {
  const app = new Hono();
  const claimed = new Map<string, string>();
  const routeIds: string[] = [];

  for (const bundle of bundles) {
    for (const mount of bundle.mounts) {
      registerMount(app, claimed, mount);
      routeIds.push(mount.id);
    }
    for (const rpc of bundle.rpcs ?? []) {
      registerRpc(app, claimed, bundle, rpc);
      routeIds.push(rpc.id);
    }
    for (const binding of bundle.bindings) {
      registerBinding(app, claimed, bundle, binding);
      routeIds.push(binding.contract.id);
    }
  }

  app.notFound(c =>
    errorResponse(404, HTTP_ERROR_CODES.notFound, `no route for ${c.req.method} ${new URL(c.req.url).pathname}`),
  );
  app.onError((error, _c) => toErrorResponse(error));

  return {
    fetch: req => Promise.resolve(app.fetch(req)),
    routeIds,
  };
}

function registerMount(app: Hono, claimed: Map<string, string>, mount: MountBinding): void {
  const key = `MOUNT ${mount.path}`;
  const prior = claimed.get(key);
  if (prior !== undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.duplicateRoute,
      message: `[http] duplicate mount at "${mount.path}": "${mount.id}" collides with "${prior}".`,
      remediation: 'Give each mounted handler a distinct path prefix.',
    });
  }
  claimed.set(key, mount.id);
  app.mount(mount.path, mount.handler);
}

function registerRpc(app: Hono, claimed: Map<string, string>, bundle: RouteBundle, rpc: RpcBinding): void {
  // Rpc mounts share the mount claim namespace: an rpc prefix colliding
  // with a raw mount (or another rpc) is the same routing bug.
  const key = `MOUNT ${rpc.path}`;
  const prior = claimed.get(key);
  if (prior !== undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.duplicateRoute,
      message: `[http] duplicate mount at "${rpc.path}": "${rpc.id}" collides with "${prior}".`,
      remediation: 'Give each mounted handler a distinct path prefix.',
    });
  }
  claimed.set(key, rpc.id);
  // `replaceRequest: false` — the bound handler must see the ORIGINAL
  // request. oRPC/tRPC fetch adapters take the mount path as their own
  // `prefix`/`endpoint` option, and derivers/`context` read `req.url`;
  // Hono's default mount rewrite (prefix-stripped URL) breaks both.
  app.mount(rpc.path, req => executeRpc(bundle, rpc, req), { replaceRequest: false });
}

function createBaseCtx(req: Request): BaseRequestCtx {
  return {
    req,
    url: new URL(req.url),
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    signal: req.signal,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

async function executeRpc(bundle: RouteBundle, rpc: RpcBinding, req: Request): Promise<Response> {
  const base = createBaseCtx(req);
  return runWithRequestContext(base, async () => {
    try {
      let ctx: BaseRequestCtx & Record<string, unknown> = base;
      for (const deriver of rpc.derivers ?? bundle.derivers) {
        // Same erasure boundary as executeBinding.
        const value = await deriver.derive(req, ctx as never);
        if (isFailure(value))
          return failureResponse(value, rpc.contract?.failures ?? [], deriver.failureHeaders?.(value));
        ctx = { ...ctx, [deriver.key]: value };
      }
      const rpcCtx = await rpc.context(req, ctx as never);
      // The rpc handler owns its subtree's responses (including its own
      // error format); only THROWN errors fall through to the envelope.
      return await rpc.handle(req, rpcCtx as never);
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

function registerBinding(app: Hono, claimed: Map<string, string>, bundle: RouteBundle, binding: RouteBinding): void {
  const { contract } = binding;
  // An optional placeholder ("/a/:x?") serves two paths and claims both.
  const keys = openApiPaths(contract.path).map(({ path }) => `${contract.method} ${path}`);
  for (const key of keys) {
    const prior = claimed.get(key);
    if (prior !== undefined) {
      throw new HttpConfigError({
        code: HTTP_ERROR_CODES.duplicateRoute,
        message: `[http] duplicate route ${contract.method} ${contract.path}: "${contract.id}" collides with "${prior}".`,
        remediation:
          'Two bindings (possibly from different bundles) claim the same method and path. Change one path, or drop the duplicate binding.',
      });
    }
  }
  for (const key of keys) claimed.set(key, contract.id);
  app.on(contract.method, contract.path, c => executeBinding(bundle, binding, c.req.raw, c.req.param()));
}

/**
 * Run one bound route. A route with no derivers and no body has nothing to
 * await before its handler, so when its schemas answer synchronously it runs
 * synchronously and returns the Response itself when the handler does — no
 * promise, no extra microtask. Anything that needs an await goes through
 * `executeBindingAsync`. Both paths give the same responses and the same
 * error envelopes.
 */
function executeBinding(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  params: Record<string, string>,
): Response | Promise<Response> {
  const base = createBaseCtx(req);
  if ((binding.derivers ?? bundle.derivers).length > 0 || binding.contract.body !== undefined) {
    return runWithRequestContext(base, () => executeBindingAsync(bundle, binding, req, base, params));
  }
  return runWithRequestContext(base, () => {
    try {
      const response = andThen(decodeInput(binding.contract, params, base), input => respond(binding, input, base));
      return response instanceof Promise ? response.catch(toErrorResponse) : response;
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

async function executeBindingAsync(
  bundle: RouteBundle,
  binding: RouteBinding,
  req: Request,
  base: BaseRequestCtx,
  params: Record<string, string>,
): Promise<Response> {
  try {
    let ctx: BaseRequestCtx & Record<string, unknown> = base;
    for (const deriver of binding.derivers ?? bundle.derivers) {
      // Erasure boundary: derivers were stored with `never` context (see
      // ErasedDeriver); the accumulated ctx is the value they were typed
      // against at composition time.
      const value = await deriver.derive(req, ctx as never);
      if (isFailure(value))
        return failureResponse(value, binding.contract.failures ?? [], deriver.failureHeaders?.(value));
      ctx = { ...ctx, [deriver.key]: value };
    }

    const body = binding.contract.body === undefined ? undefined : await readJson(req);
    const input = await decodeInput(binding.contract, params, base, body);
    return await respond(binding, input, ctx);
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Call the handler and turn what it returns into a Response. Throws on a bad output. */
function respond(binding: RouteBinding, input: ErasedInput, ctx: BaseRequestCtx): Response | Promise<Response> {
  if (binding.contract.kind === 'sse') {
    // Erasure boundary, same as above — input/ctx match the handler's
    // composition-time types.
    const events = (binding.handler as (input: never, ctx: never) => AsyncIterable<unknown>)(
      input as never,
      ctx as never,
    );
    return sseResponse(events, binding.contract, ctx.signal);
  }

  const returned = binding.handler(input as never, ctx as never);
  if (isPromiseLike(returned)) return settle(binding, returned);
  return toResponse(binding.contract, returned, binding.failureHeaders);
}

async function settle(binding: RouteBinding, pending: PromiseLike<unknown>): Promise<Response> {
  try {
    return await toResponse(binding.contract, await pending, binding.failureHeaders);
  } catch (error) {
    return toErrorResponse(error);
  }
}

function failureResponse(
  failure: Failure,
  definitions: NonNullable<ContractLike['failures']>,
  headers?: Readonly<Record<string, string>>,
): Response {
  const wire = serialize(failure, definitions);
  const outcome = isFailure(wire) ? wire : failure;
  return errorResponse(outcome.status, outcome.code, outcome.message, {
    ...(outcome.remediation === undefined ? {} : { remediation: outcome.remediation }),
    ...(headers === undefined ? {} : { headers }),
    ...(isFailure(wire)
      ? wire.data === undefined
        ? {}
        : { data: wire.data }
      : 'data' in wire
        ? { data: wire.data }
        : {}),
  });
}

function toResponse(
  contract: ContractLike,
  result: unknown,
  failureHeaders?: RouteBinding['failureHeaders'],
): Response | Promise<Response> {
  if (isFailure(result)) return failureResponse(result, contract.failures ?? [], failureHeaders?.(result));
  // `raw()` is the only way to send a Response, and the only way to skip the
  // schemas: in raw mode the handler owns the bytes, so nothing is checked.
  const rawMode = isRawOutput(contract.output);
  if (result instanceof Response) {
    if (rawMode) return result;
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.rawResponseMismatch,
      `handler for "${contract.id}" returned a Response but the contract does not declare output: raw()`,
      { remediation: 'Declare output: raw() on the contract, or return the output value.' },
    );
  }
  if (rawMode) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.rawResponseMismatch,
      `handler for "${contract.id}" declares output: raw() but did not return a Response`,
      { remediation: 'Return a Response from the handler, or declare an output schema.' },
    );
  }
  if (isReply(result)) return serializeReply(contract, result);
  if (contract.output === undefined) {
    if (result === undefined) return new Response(null, { status: 204 });
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.invalidResponse,
      `handler for "${contract.id}" returned a value but the contract declares no output schema`,
      { remediation: 'Declare an output schema on the contract, or return nothing to answer 204.' },
    );
  }
  return andThen(encodeOutput(contract, contract.output, result), encoded => jsonResponse(encoded));
}

function serializeReply(
  contract: ContractLike,
  result: { readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> },
): Response | Promise<Response> {
  const schema = contract.responses?.[result.status];
  if (schema === undefined) {
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.invalidResponse,
      `handler for "${contract.id}" replied ${result.status}, which the contract does not declare in responses`,
      { remediation: 'Add the status to "responses" on the contract, or reply with a declared status.' },
    );
  }
  return andThen(encodeOutput(contract, schema, result.body), encoded =>
    jsonResponse(encoded, result.status, result.headers),
  );
}

/** The body as JSON; a body that is not JSON answers 400. */
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, HTTP_ERROR_CODES.badRequest, 'request body is not valid JSON', {
      remediation: 'Send a JSON body with content-type: application/json.',
      cause: InvalidInput({ issues: [{ path: ['body'], message: 'must be valid JSON' }] }),
    });
  }
}

/** One decode job per declared field. A missing optional field gets no job: it stays `undefined`. */
function fieldJobs(
  where: Where,
  fields: Readonly<Record<string, Field>>,
  read: (key: string) => string | undefined,
): Job[] {
  const jobs: Job[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const { wire, optional } = fieldParts(field);
    const value = read(key);
    if (value === undefined && optional) continue;
    // The `optional(...)` marker decides presence, even for a schema that accepts `undefined`.
    jobs.push({ at: [where, key], schema: value === undefined ? missingField : decoderOf(wire), value });
  }
  return jobs;
}

/** Multi-valued query keys collapse to their last value. */
function lastQueryValue(base: BaseRequestCtx, key: string): string | undefined {
  return base.url.searchParams.getAll(key).at(-1);
}

/**
 * Decode the request: each declared field from its one string (or
 * `undefined`), then the body, then the contract's `check`. Every field and
 * body issue answers one 400; a schema that throws answers 500.
 */
function decodeInput(
  contract: ContractLike,
  params: Record<string, string>,
  base: BaseRequestCtx,
  body?: unknown,
): MaybePromise<ErasedInput> {
  const jobs: Job[] = [];
  if (contract.params !== undefined) jobs.push(...fieldJobs('params', contract.params, key => params[key]));
  if (contract.headers !== undefined) {
    jobs.push(...fieldJobs('headers', contract.headers, key => base.req.headers.get(key) ?? undefined));
  }
  if (contract.query !== undefined) jobs.push(...fieldJobs('query', contract.query, key => lastQueryValue(base, key)));
  if (contract.body !== undefined) jobs.push({ at: ['body'], schema: decoderOf(contract.body), value: body });
  return andThen(runJobs(jobs), runs => assemble(contract, params, runs));
}

function assemble(contract: ContractLike, params: Record<string, string>, runs: readonly Ran[]): ErasedInput {
  rejectIssues(issuesOf(runs));
  const decoded: Record<Exclude<Where, 'body'>, Record<string, unknown>> = { params: {}, headers: {}, query: {} };
  let body: unknown;
  for (const { job, result } of runs) {
    const [where, key] = job.at;
    if (result.issues !== undefined) continue;
    if (where === 'body') body = result.value;
    else if (key !== undefined) decoded[where][key] = result.value;
  }
  const input: ErasedInput = {
    params: contract.params === undefined ? params : decoded.params,
    headers: contract.headers === undefined ? undefined : decoded.headers,
    query: contract.query === undefined ? undefined : decoded.query,
    body,
  };
  if (contract.check !== undefined) rejectIssues(contract.check(input) ?? []);
  return input;
}

/** Throw the 400 for any issue: `request validation failed: query.page: …`. */
function rejectIssues(issues: readonly StandardSchemaV1.Issue[]): void {
  if (issues.length === 0) return;
  throw new HttpError(400, HTTP_ERROR_CODES.badRequest, `request validation failed: ${formatIssues(issues)}`, {
    cause: InvalidInput({ issues }),
  });
}

/**
 * Encode, not decode: output leaves the server, so a codec runs its
 * `encode` side (a `Date` goes out as an ISO string). Issues answer 500.
 */
function encodeOutput(contract: ContractLike, wire: Wire, result: unknown): MaybePromise<unknown> {
  return andThen(runSchema(encoderOf(wire), result), outcome => {
    if (outcome.issues === undefined) return outcome.value;
    throw new HttpError(
      500,
      HTTP_ERROR_CODES.internal,
      `handler output for "${contract.id}" violates the contract's output schema: ${formatIssues(outcome.issues)}`,
      { cause: InvalidInput({ issues: outcome.issues }) },
    );
  });
}

/**
 * Same response as `Response.json(value)` — the body is `JSON.stringify(value)`
 * and the content type `application/json` — built from a string body, which
 * costs less per request than `Response.json` in undici.
 */
function jsonResponse(value: unknown, status = 200, headers?: Readonly<Record<string, string>>): Response {
  const text = JSON.stringify(value);
  // `Response.json` refuses a value with no JSON form (undefined, a function).
  if (text === undefined) throw new TypeError('Value is not JSON serializable');
  return new Response(text, {
    status,
    headers:
      headers === undefined
        ? { 'content-type': 'application/json' }
        : { ...headers, 'content-type': 'application/json' },
  });
}

/**
 * App-wide middleware: a fetch-shaped wrapper. The first middleware in a
 * list runs outermost. Use for cross-cutting concerns that must see or
 * touch the raw request/response — CORS, request logging, compression.
 * For per-request *values* (auth principals, tenant handles), use
 * derivers — they are typed into handler contexts; middleware is not.
 */
export type HttpMiddleware = (req: Request, next: (req: Request) => Promise<Response>) => Response | Promise<Response>;

/**
 * Wrap a fetch handler in middleware (first = outermost). A middleware
 * that throws resolves to the coded error envelope — `HttpError` keeps
 * its status, anything else is a 500.
 */
export function composeMiddleware(
  fetch: (req: Request) => Promise<Response>,
  middleware: readonly HttpMiddleware[],
): (req: Request) => Promise<Response> {
  let composed = fetch;
  for (const layer of middleware.toReversed()) {
    const next = composed;
    composed = async req => await layer(req, next);
  }
  const outermost = composed;
  return async req => {
    try {
      return await outermost(req);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
