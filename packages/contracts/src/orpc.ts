/**
 * Operations: one typed identity per contract procedure.
 *
 * An oRPC contract already knows every procedure's path, input, output,
 * errors and meta. `operations(contract)` turns that into plain data — a
 * tree of {@link Operation}s — so the client can carry the identity next to
 * its query utils and a policy written once on the contract (say,
 * `offlineSafe: true`) can be checked by the compiler where it is used.
 *
 * Plain objects, no Proxy. Safe to log, compare by `name`, and persist
 * (`path` and `name` only). The walk reads only path and meta, so a
 * `minifyContractRouter` output works the same as the full contract.
 */
import { getContractRouter, isContractProcedure } from '@orpc/contract';
import type {
  AnyContractRouter,
  ContractProcedure,
  ErrorFromErrorMap,
  InferSchemaInput,
  InferSchemaOutput,
  Meta,
} from '@orpc/contract';

/** One procedure's identity. The types ride along in a phantom field. */
export type Operation<TInput, TOutput, TError, TMeta extends Meta> = {
  /** `['posts', 'create']` */
  readonly path: readonly string[];
  /** `'posts.create'` — the same string the server stores as `procedure_path`. */
  readonly name: string;
  /** The contract's meta, value and type. */
  readonly meta: TMeta;
  /** Phantom. Never assigned; carries the types only. */
  readonly '~types'?: { readonly input: TInput; readonly output: TOutput; readonly error: TError };
};

/** Any operation at all. */
export type AnyOperation = Operation<unknown, unknown, unknown, Meta>;

/** The operation of one contract procedure. Input is the client side of the schema; output the parsed side. */
export type OperationOf<C> =
  C extends ContractProcedure<infer I, infer O, infer E, infer M>
    ? Operation<InferSchemaInput<I>, InferSchemaOutput<O>, ErrorFromErrorMap<E>, M>
    : never;

/** The operation tree of a contract: the same keys, an {@link Operation} at every leaf. */
export type Operations<C> =
  C extends ContractProcedure<infer _I, infer _O, infer _E, infer _M>
    ? OperationOf<C>
    : { readonly [K in keyof C & string]: Operations<C[K]> };

export type InputOf<Op extends AnyOperation> = NonNullable<Op['~types']>['input'];
export type OutputOf<Op extends AnyOperation> = NonNullable<Op['~types']>['output'];
export type ErrorOf<Op extends AnyOperation> = NonNullable<Op['~types']>['error'];
export type MetaOf<Op extends AnyOperation> = Op['meta'];

/** Key under which a utils object carries its operation. `~` like oRPC's own `'~orpc'`. */
export const OPERATION = '~op';

/** A value that carries an operation under {@link OPERATION} — a utils leaf from `createOrpcUtils`. */
export type Identified<Op extends AnyOperation> = { readonly [OPERATION]: Op };

/**
 * Keys a contract may not use. A group's utils object holds its children
 * next to the query-utils methods, so a child named `key` (or any of these)
 * would be silently shadowed. oRPC's own proxy has the same collision; we
 * fail loud instead.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  OPERATION,
  'key',
  'call',
  'queryKey',
  'queryOptions',
  'infiniteKey',
  'infiniteOptions',
  'mutationKey',
  'mutationOptions',
]);

function operationFor(procedure: { readonly '~orpc': { readonly meta: Meta } }, path: readonly string[]): AnyOperation {
  return Object.freeze({ path: Object.freeze([...path]), name: path.join('.'), meta: procedure['~orpc'].meta });
}

function checkKey(key: string, path: readonly string[]): void {
  const where = [...path, key].join(' > ');
  if (key.includes('.')) {
    throw new TypeError(`Contract key "${key}" at ${where} contains ".": operation names join the path with ".", so it would be ambiguous.`);
  }
  if (RESERVED_KEYS.has(key)) {
    throw new TypeError(`Contract key "${key}" at ${where} is reserved: the query utils use that name on every group.`);
  }
}

function walk(node: AnyContractRouter, path: readonly string[]): unknown {
  if (isContractProcedure(node)) return operationFor(node, path);
  const tree: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    checkKey(key, path);
    tree[key] = walk(child, [...path, key]);
  }
  return Object.freeze(tree);
}

/**
 * Walk a contract once and return its operation tree. Throws `TypeError`,
 * naming the path, for a key that contains `.` or is reserved (`~op`, `key`,
 * `call`, `queryKey`, `queryOptions`, `infiniteKey`, `infiniteOptions`,
 * `mutationKey`, `mutationOptions`).
 */
export function operations<const C extends AnyContractRouter>(contract: C): Operations<C>;
// Erasure seam: TypeScript cannot check a recursive walk against the recursive
// mapped type `Operations<C>`, so the implementation returns `unknown` and the
// overload above states the result. The type tests in `orpc.test-d.ts` pin it.
export function operations(contract: AnyContractRouter): unknown {
  return walk(contract, []);
}

/** The operation at a path, or `undefined`. For replay loops and tools. */
export function operationAt(contract: AnyContractRouter, path: readonly string[]): AnyOperation | undefined {
  const node = getContractRouter(contract, path);
  return isContractProcedure(node) ? operationFor(node, path) : undefined;
}

function isOperation(value: unknown): value is AnyOperation {
  if (typeof value !== 'object' || value === null) return false;
  const path: unknown = Reflect.get(value, 'path');
  const meta: unknown = Reflect.get(value, 'meta');
  return (
    Array.isArray(path) &&
    path.every(segment => typeof segment === 'string') &&
    Reflect.get(value, 'name') === path.join('.') &&
    typeof meta === 'object' &&
    meta !== null
  );
}

/**
 * Read the operation a value carries. Throws `TypeError` for a value that
 * has none — a raw oRPC client or utils leaf, or a forged object — so plain
 * JavaScript callers get the same check the compiler gives TypeScript ones.
 */
export function operationOf<Op extends AnyOperation>(carrier: Identified<Op>): Op;
export function operationOf(carrier: unknown): AnyOperation {
  const op: unknown = typeof carrier === 'object' && carrier !== null ? Reflect.get(carrier, OPERATION) : undefined;
  if (!isOperation(op)) {
    throw new TypeError(
      `Expected a value that carries an operation under "${OPERATION}" (a leaf of createOrpcUtils); got one without it.`,
    );
  }
  return op;
}
