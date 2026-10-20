import type { Failure } from '@arki/failure';

import type { RequestId } from './ids.js';

/**
 * Request-scope derivers — "scope is data, not containers."
 *
 * A deriver is a named function from `(req, ctx)` to a value; each one
 * adds a typed key to the per-request context handlers receive. Derivers
 * run in declaration order, later derivers see earlier keys typed, and a
 * a returned canonical failure short-circuits into the wire envelope.
 * Each bound contract must declare the derivers' inferred failures:
 *
 * ```ts
 * const SignIn = defineFailure('auth.sign_in', { status: 401 });
 * const withPrincipal = derive('principal', async req => {
 *   const p = await auth.verify(req.headers.get('authorization'));
 *   if (!p) return SignIn();
 *   return p;
 * });
 * ```
 *
 * Because bundles are assembled inside a plugin's `boot`, derivers close over
 * injected singletons — request scope is function application over the
 * compile-time-wired service graph, not per-request container resolution.
 */

/**
 * The context every handler and deriver receives. Derivers extend it with
 * their own typed keys; the base keys are reserved.
 */
export type BaseRequestCtx = {
  readonly req: Request;
  readonly url: URL;
  /** Inbound `x-request-id` header, else a fresh UUID. */
  readonly requestId: RequestId;
  /** Aborts when the client disconnects. */
  readonly signal: AbortSignal;
};

/** Base context keys — derivers may not shadow these. */
export const BASE_CTX_KEYS = ['req', 'url', 'requestId', 'signal'] as const;

/**
 * A named, typed context deriver. `TIn` is the context the deriver needs
 * to see — a deriver written against {@link BaseRequestCtx} composes into
 * any bundle; one written against a richer context can only be added
 * after the derivers that provide it.
 */
/** Transport metadata for an inferred returned failure; execution remains server-bound. */
export type FailureHeaders<Value> = {
  readonly failureHeaders?: (
    this: void,
    failure: Extract<Awaited<Value>, Failure>,
  ) => Readonly<Record<string, string>> | undefined;
};

export type Deriver<
  K extends string = string,
  V = unknown,
  TIn extends BaseRequestCtx = BaseRequestCtx,
> = FailureHeaders<V> & {
  readonly key: K;
  readonly derive: (req: Request, ctx: TIn) => V | Promise<V>;
};

/** Create a reusable {@link Deriver}. */
export function derive<K extends string, V, TIn extends BaseRequestCtx = BaseRequestCtx>(
  key: K,
  fn: (req: Request, ctx: TIn) => V | Promise<V>,
  options: FailureHeaders<NoInfer<V>> = {},
): Deriver<K, V, TIn> {
  return { key, derive: fn, ...options };
}

/**
 * Generics-erased deriver view for bundle storage. Typed derivers are
 * assignable via parameter contravariance from the bottom type; the
 * engine crosses the erasure boundary at the call site (`ctx as never`),
 * mirroring the DOT kernel's hook-storage pattern.
 */
export type ErasedFailureHeaders = {
  failureHeaders?(this: void, failure: Failure): ReturnType<NonNullable<FailureHeaders<Failure>['failureHeaders']>>;
};

export type ErasedDeriver = ErasedFailureHeaders & {
  readonly key: string;
  readonly derive: (req: Request, ctx: never) => unknown;
};
