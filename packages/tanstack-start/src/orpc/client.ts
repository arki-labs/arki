/**
 * oRPC Client Setup for TanStack Start
 *
 * Provides client-side oRPC configuration with TanStack Query integration.
 * Unlike tRPC, oRPC doesn't need its own React context — it works directly
 * with TanStack Query's QueryClient via generated query/mutation options.
 *
 * The utils are built from the contract VALUE, so every leaf also carries
 * its operation (`'~op'`: path, name, meta — see `@arki/contracts/orpc`).
 * Keys are oRPC's own, so these utils and `createTanstackQueryUtils(client)`
 * share one cache.
 */

import type { Client, ClientContext, NestedClient } from '@orpc/client';
import type { RPCLinkOptions } from '@orpc/client/fetch';
import type { AnyContractRouter, ContractProcedure, ContractRouterClient, ErrorFromErrorMap, InferSchemaInput, InferSchemaOutput } from '@orpc/contract';
import type { GeneralUtils, ProcedureUtils } from '@orpc/tanstack-query';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { isContractProcedure } from '@orpc/contract';
import { createGeneralUtils, createProcedureUtils } from '@orpc/tanstack-query';

import type { Identified, OperationOf } from '@arki/contracts/orpc';
import { OPERATION, operations } from '@arki/contracts/orpc';

/** oRPC's `ProcedureUtils` + `GeneralUtils` per leaf, plus the operation. Groups keep `key()`. */
export type OrpcUtils<C, TCtx extends ClientContext> =
  C extends ContractProcedure<infer I, infer O, infer E, infer _M>
    ? ProcedureUtils<TCtx, InferSchemaInput<I>, InferSchemaOutput<O>, ErrorFromErrorMap<E>> &
        GeneralUtils<InferSchemaInput<I>> &
        Identified<OperationOf<C>>
    : { readonly [K in keyof C as K & string]: OrpcUtils<C[K], TCtx> } & GeneralUtils<unknown>;

type AnyClient = Client<ClientContext, unknown, unknown, unknown>;

/** The context type of an oRPC client tree (oRPC's `InferClientContext`, without its `any` constraint). */
type ClientContextOf<TClient> = TClient extends NestedClient<infer TCtx> ? TCtx : never;

// oRPC's client is a callable Proxy at every node, so a leaf is a function.
function isClient(value: unknown): value is AnyClient {
  return typeof value === 'function';
}

/** `value[key]` for an object or a callable Proxy; `undefined` otherwise. */
function child(value: unknown, key: string): unknown {
  return (typeof value === 'object' || typeof value === 'function') && value !== null ? Reflect.get(value, key) : undefined;
}

function build(node: AnyContractRouter, ops: unknown, client: unknown, path: readonly string[]): unknown {
  if (isContractProcedure(node)) {
    if (!isClient(client)) throw new TypeError(`The client has no procedure at ${path.join('.')}`);
    return { ...createGeneralUtils(path), ...createProcedureUtils(client, { path }), [OPERATION]: ops };
  }
  const group: Record<string, unknown> = { ...createGeneralUtils(path) };
  for (const [key, next] of Object.entries(node)) {
    Object.defineProperty(group, key, {
      value: build(next, child(ops, key), child(client, key), [...path, key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return group;
}

/**
 * Low level: bind a contract to a client you built (your own link,
 * serializers, context). Walks the contract once, eagerly; throws the
 * `operations()` build-time errors (a key with `.`, a reserved key).
 *
 * @example
 * ```ts
 * const client: ContractRouterClient<typeof rpcContract> = createORPCClient(link);
 * export const orpc = createOrpcUtils(rpcContract, client);
 * orpc.posts.create['~op'].name; // 'posts.create'
 * ```
 */
// `ContractRouterClient<C, never>`: a client for this contract with ANY context — every
// context type is assignable where `never` is expected. The real one is read back from it.
export function createOrpcUtils<const C extends AnyContractRouter, TClient extends ContractRouterClient<C, never>>(
  contract: C,
  client: TClient,
): OrpcUtils<C, ClientContextOf<TClient>>;
// Erasure seam: TypeScript cannot check a recursive walk against the recursive
// mapped type `OrpcUtils<C, …>` (same as `routerFor` in `@arki/dot`), so the
// implementation returns `unknown` and the overload above states the result.
// `client.test-d.ts` pins it.
export function createOrpcUtils(contract: AnyContractRouter, client: unknown): unknown {
  return build(contract, operations(contract), client, []);
}

export type ORPCClientConfig<TCtx extends ClientContext> = {
  /**
   * Base URL for the oRPC API endpoint
   * @default '/api/orpc'
   */
  readonly url?: string;
  /**
   * Custom headers to include in requests. Called before each request with
   * the call's options, so per-call context can become a header.
   */
  readonly headers?: (options: { readonly context?: TCtx }) => Record<string, string> | Promise<Record<string, string>>;
  /** Extra JSON serializers, e.g. `temporalJsonSerializers` from `@arki/date/orpc`. */
  readonly customJsonSerializers?: RPCLinkOptions<TCtx>['customJsonSerializers'];
};

/**
 * High level: link + client + utils in one call.
 *
 * @example
 * ```tsx
 * // lib/orpc.ts
 * import { createORPCReact, getORPCUrl } from '@arki/tanstack-start/orpc/client';
 * import { rpcContract } from '@my-app/backend/rpc';
 *
 * export const { client, orpc } = createORPCReact(rpcContract, { url: getORPCUrl() });
 *
 * // In components — use with TanStack Query hooks:
 * const { data } = useQuery(orpc.documents.list.queryOptions({ input: {} }));
 * const mutation = useMutation(orpc.documents.create.mutationOptions());
 * ```
 */
export function createORPCReact<const C extends AnyContractRouter, TCtx extends ClientContext = Record<never, never>>(
  contract: C,
  config: ORPCClientConfig<TCtx> = {},
) {
  const { url = '/api/orpc', headers, customJsonSerializers } = config;

  const link = new RPCLink<TCtx>({
    url,
    headers: options => headers?.(options) ?? {},
    ...(customJsonSerializers === undefined ? {} : { customJsonSerializers }),
  });

  const client: ContractRouterClient<C, TCtx> = createORPCClient(link);
  return { client, orpc: createOrpcUtils(contract, client) };
}

/**
 * Gets the base URL for oRPC based on environment.
 *
 * - Browser: returns relative URL `/api/orpc`
 * - SSR: uses `VITE_ORPC_URL` or `ORPC_URL` env var, falling back to localhost
 */
export function getORPCUrl(): string {
  // Browser: use relative URL
  if (typeof window !== 'undefined') {
    return '/api/orpc';
  }

  // SSR: use environment variable or localhost
  const url = process.env.VITE_ORPC_URL ?? process.env.ORPC_URL;
  if (url) return url;

  // Default to localhost for development
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}/api/orpc`;
}

export { createORPCClient } from '@orpc/client';
export { RPCLink } from '@orpc/client/fetch';
export { createTanstackQueryUtils } from '@orpc/tanstack-query';
export { type RouterClient } from '@orpc/server';
