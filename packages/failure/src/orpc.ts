/**
 * `@arki/failure/orpc` — failures at an oRPC boundary.
 *
 * Define each failure once with `defineFailure`. The contract lists them with
 * `errorMap(...)`, so the client gets typed errors. The procedure hands the
 * usecase's result to `orThrowRpc(...)`, which returns the value or throws the
 * matching `ORPCError`. Code, status and data come from the same definition,
 * so the contract and the usecase cannot drift apart.
 *
 * @example
 * // model/errors.ts
 * export const PostNotFound = defineFailure('post.not_found', { status: 404, data: z.object({ id: PostId }) });
 * // entrypoints/rpc.ts
 * byId: oc.errors(errorMap(PostNotFound)).input(z.object({ id: PostId })).output(PostSchema),
 * // entrypoints/procedures.ts
 * byId: impl => impl.byId.handler(({ context, input }) => orThrowRpc(context.usecases.find(input.id))),
 */
import { ORPCError } from '@orpc/server';

import type { Failure } from './failure.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import { FAILURE_ERROR_CODES, FailureError } from './errors.js';
import { isFailure, isThenable } from './failure.js';

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

/**
 * The value, or throw its failure as the `ORPCError` the contract declares
 * (same code, status, message and data). Takes a promise too, so a handler can
 * return `orThrowRpc(usecase(input))` directly.
 */
export function orThrowRpc<Value>(value: PromiseLike<Value>): Promise<Exclude<Value, Failure>>;
export function orThrowRpc<Value>(value: Value): Exclude<Value, Failure>;
export function orThrowRpc(value: unknown): unknown {
  if (isThenable(value)) return Promise.resolve(value).then(orThrowRpcNow);
  return orThrowRpcNow(value);
}

function orThrowRpcNow(value: unknown): unknown {
  if (!isFailure(value)) return value;
  throw new ORPCError(value.code, { status: value.status, message: value.message, data: value.data });
}
