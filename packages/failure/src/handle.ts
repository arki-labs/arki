/**
 * Handling a value that may be a failure: all of it (`match`), part of it
 * (`recover`), or proving a branch cannot happen (`assertNever`).
 */
import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES, FailureError } from './errors.js';
import { isFailure } from './failure.js';

/** The failure codes a value can carry. */
type FailureCodes<Value> = Extract<Value, Failure>['code'];

/** The failure of `Value` with this code. */
type FailureWithCode<Value, Code> = Extract<Extract<Value, Failure>, { readonly code: Code }>;

/** One handler for the success value (`ok`) and one per failure code the value can carry. All are required. */
export type MatchHandlers<Value> = {
  readonly ok: (value: Exclude<Value, Failure>) => unknown;
} & {
  readonly [Code in FailureCodes<Value>]: (failure: FailureWithCode<Value, Code>) => unknown;
};

/** Handlers for some of the failure codes a value can carry. */
export type RecoverHandlers<Value> = {
  readonly [Code in FailureCodes<Value>]?: (failure: FailureWithCode<Value, Code>) => unknown;
};

/** A handler for a code the value cannot carry is a stale handler: make it a type error. */
type NoStaleHandlers<Handlers, Allowed> = Readonly<Record<Exclude<keyof Handlers, Allowed>, never>>;

/** The union of what the handlers return. */
type HandlerResult<Handlers> = {
  [Key in keyof Handlers]-?: Handlers[Key] extends (...args: never[]) => infer Out ? Out : never;
}[keyof Handlers];

/**
 * Handle the success value and every failure the value can carry. A missing
 * handler is a type error, and so is a handler for a code that can no longer
 * happen, so adding or removing a failure updates every `match` at compile time.
 *
 * @example
 * const title = match(await find(id), {
 *   ok: post => post.title,
 *   'post.not_found': failure => `missing ${failure.data.id}`,
 * });
 */
export function match<Value, Handlers extends MatchHandlers<Value>>(
  value: Value,
  handlers: Handlers & NoStaleHandlers<Handlers, 'ok' | FailureCodes<Value>>,
): HandlerResult<Handlers>;
export function match(value: unknown, handlers: Readonly<Record<string, (input: unknown) => unknown>>): unknown {
  const key = isFailure(value) ? value.code : 'ok';
  const handler = handlers[key];
  if (handler === undefined) {
    throw new FailureError(
      FAILURE_ERROR_CODES.unhandledFailure,
      `match() has no handler for "${key}"`,
      'Add a handler for this code. The type of match() lists every code the value can carry, so this only happens when the types were bypassed.',
    );
  }
  return handler(value);
}

/**
 * Handle some failures and pass the rest through. The result type drops the
 * handled codes and adds what their handlers return, so the compiler tracks
 * exactly which failures are still possible.
 *
 * @example
 * const post = recover(await find(id), { 'post.not_found': () => draft(id) });
 * //    ^? Post | Draft | Failure<'db.timeout', …>   ('post.not_found' is gone)
 */
export function recover<Value, Handlers extends RecoverHandlers<Value>>(
  value: Value,
  handlers: Handlers & NoStaleHandlers<Handlers, FailureCodes<Value>>,
): Exclude<Value, Failure<Extract<keyof Handlers, string>, unknown>> | HandlerResult<Handlers>;
export function recover(value: unknown, handlers: Readonly<Record<string, (input: unknown) => unknown>>): unknown {
  if (!isFailure(value)) return value;
  const handler = handlers[value.code];
  return handler === undefined ? value : handler(value);
}

/**
 * Mark a branch that cannot be reached. Put it in the `default` of a switch
 * over a union: when the union gains a member, the call stops compiling.
 *
 * @example
 * switch (shape.kind) {
 *   case 'circle': return area(shape);
 *   case 'square': return side(shape) ** 2;
 *   default: return assertNever(shape);
 * }
 */
export function assertNever(value: never, message?: string): never {
  throw new FailureError(
    FAILURE_ERROR_CODES.unreachable,
    message ?? `assertNever() was reached with ${describe(value)}`,
    'A union gained a member this code does not handle. Add a branch for it.',
  );
}

/** JSON.stringify as it behaves: it returns undefined for undefined, functions and symbols. */
const stringify: (value: unknown) => string | undefined = JSON.stringify;

function describe(value: unknown): string {
  try {
    return stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
