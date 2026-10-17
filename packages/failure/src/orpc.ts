/**
 * `@arki/failure/orpc` — failures at an oRPC boundary.
 *
 * Define each failure once with `defineFailure`. The contract lists them with
 * `errorMap(...)`, so the client gets typed errors. The procedure hands the
 * usecase's result to `orThrowRpc(...)`, which returns the value or throws the
 * matching `ORPCError`. It also takes the handler's `errors`, so a failure the
 * usecase can return but the contract does not list is a compile error. On the
 * client, `reviveRpcError(...)` turns the caught `ORPCError` back into the failure.
 *
 * @example
 * // model/errors.ts
 * export const PostNotFound = defineFailure('post.not_found', { status: 404, data: z.object({ id: PostId }) });
 * // entrypoints/rpc.ts
 * byId: oc.errors(errorMap(PostNotFound)).input(z.object({ id: PostId })).output(PostSchema),
 * // entrypoints/procedures.ts
 * byId: impl => impl.byId.handler(({ context, input, errors }) => orThrowRpc(context.usecases.find(input.id), errors)),
 * // the frontend: the caught ORPCError back as the failure, ready for match()
 * const failure = reviveRpcError(error, [PostNotFound]);
 */
import { ORPCError } from '@orpc/client';

import type { StandardSchemaV1 } from '@arki/schema';

import type { Failure } from './failure.js';
import { FAILURE_ERROR_CODES, FailureError } from './errors.js';
import { isFailure, isThenable } from './failure.js';
import { revive } from './revive.js';

/** The parts of a `FailureDefinition` an error map needs. */
type DefinitionShape = {
  readonly code: string;
  readonly status: number;
  readonly dataSchema: StandardSchemaV1 | undefined;
};

/** The oRPC error map for a list of definitions: one entry per code, with its status and data schema. */
export type ErrorMapOf<Definitions extends readonly DefinitionShape[]> = {
  readonly [Definition in Definitions[number] as Definition['code']]: Definition['dataSchema'] extends StandardSchemaV1
    ? { readonly status: number; readonly data: Definition['dataSchema'] }
    : { readonly status: number };
};

/**
 * The oRPC error map for these definitions, for a contract's `.errors(...)`.
 * Two definitions with the same code throw `ARKI_FAILURE_E005`.
 */
export function errorMap<const Definitions extends readonly DefinitionShape[]>(
  ...definitions: Definitions
): ErrorMapOf<Definitions>;
export function errorMap(...definitions: readonly DefinitionShape[]): unknown {
  const seen = new Set<string>();
  const entries: [string, { status: number; data?: StandardSchemaV1 }][] = [];
  for (const { code, status, dataSchema } of definitions) {
    if (seen.has(code)) {
      throw new FailureError(
        FAILURE_ERROR_CODES.duplicateCode,
        `errorMap() got two definitions with the code "${code}"`,
        'Give each defineFailure() a unique code, or pass the shared definition once.',
      );
    }
    seen.add(code);
    entries.push([code, dataSchema === undefined ? { status } : { status, data: dataSchema }]);
  }
  return Object.fromEntries(entries);
}

/** One oRPC error constructor, as the handler's `errors` object holds them. */
type ErrorConstructor<Data> = (options: { readonly message: string; readonly data: Data }) => Error;

/**
 * The handler's `errors` must hold a constructor for every failure code the
 * value can carry. A code the contract does not list is a missing property.
 */
export type DeclaredErrors<Value> = {
  readonly [Code in Extract<Value, Failure>['code']]: ErrorConstructor<Extract<Value, Failure<Code>>['data']>;
};

/** The loose shape the implementation reads; the overloads above keep it typed. */
type LooseErrors = Readonly<Partial<Record<string, ErrorConstructor<unknown>>>>;

/**
 * The value, or throw its failure through the handler's `errors`, the typed
 * `ORPCError` the contract declares (same code, status, message and data).
 * Pass the handler's `errors`: a failure the contract does not list is a
 * compile error. Takes a promise too, so a handler can return
 * `orThrowRpc(usecase(input), errors)` directly.
 *
 * With a third argument it answers `success` instead of the value, for a
 * usecase that returns nothing or a failure:
 * `return orThrowRpc(await disconnect(id), errors, { success: true })`.
 */
export function orThrowRpc<Value>(
  value: PromiseLike<Value>,
  errors: NoInfer<DeclaredErrors<Value>>,
): Promise<Exclude<Value, Failure>>;
export function orThrowRpc<Value>(
  value: Value,
  errors: NoInfer<DeclaredErrors<Awaited<Value>>>,
): Exclude<Value, Failure>;
export function orThrowRpc<Value, Success>(
  value: PromiseLike<Value>,
  errors: NoInfer<DeclaredErrors<Value>>,
  success: Success,
): Promise<Success>;
export function orThrowRpc<Value, Success>(
  value: Value,
  errors: NoInfer<DeclaredErrors<Awaited<Value>>>,
  success: Success,
): Success;
export function orThrowRpc(value: unknown, errors: LooseErrors, ...success: readonly [] | readonly [unknown]): unknown {
  if (isThenable(value)) return Promise.resolve(value).then(resolved => orThrowRpcNow(resolved, errors, success));
  return orThrowRpcNow(value, errors, success);
}

/** Throw the failure, or answer `success` when one was passed, else the value. */
function orThrowRpcNow(value: unknown, errors: LooseErrors, success: readonly [] | readonly [unknown]): unknown {
  if (!isFailure(value)) return success.length === 0 ? value : success[0];
  const declared = errors[value.code];
  // Reached only when the types were bypassed: the client sees an undeclared error (`defined: false`).
  if (declared === undefined) {
    throw new ORPCError(value.code, { status: value.status, message: value.message, data: value.data });
  }
  throw declared({ message: value.message, data: value.data });
}

/** The parts of a definition {@link reviveRpcError} needs: the same as `revive`. */
type RevivableDefinition = {
  readonly code: string;
  readonly dataSchema: StandardSchemaV1 | undefined;
  (...args: never[]): unknown;
};

/**
 * The live failure a caught `ORPCError` stands for, when its code is one of
 * `definitions`; `undefined` for any other error. Data is checked with the
 * definition's schema like `revive`, so data that does not match throws
 * `ARKI_FAILURE_E006`. Use it on the client to `match` on failures the
 * contract declares.
 *
 * @example
 * const post = await client.posts.byId({ id }).catch((error: unknown) => {
 *   const failure = reviveRpcError(error, [PostNotFound]);
 *   if (failure === undefined) throw error; // not a declared failure: still a bug
 *   return failure;
 * });
 * //    ^? Post | Failure<'post.not_found', { id: string }>
 */
export function reviveRpcError<const Definitions extends readonly RevivableDefinition[]>(
  error: unknown,
  definitions: Definitions,
): ReturnType<Definitions[number]> | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  return revive(error, definitions);
}
