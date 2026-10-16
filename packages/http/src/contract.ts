/**
 * Route contracts — the static half of an HTTP surface.
 *
 * A contract is pure data at module scope: method + path + zod schemas +
 * a stable id. No handler, no services, no I/O. That split is what makes
 * three things possible at once:
 *
 *  - `configure` can register it in the DOT manifest (configure is sync);
 *  - OpenAPI generation is static — no boot required;
 *  - the handler signature is fully inferred when the contract is bound
 *    (see `routes().bind()` in `bundle.ts`).
 */

import type { z } from 'zod';

import type { Failure, StandardSchemaV1 } from '@arki/failure';

import type { RouteMeta } from './openapi.js';
import { contractMeta } from './openapi.js';

/** Methods a {@link RouteContract} can declare. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Path-parameter names extracted from a path literal at the type level:
 * `'/orders/:id/items/:itemId'` → `'id' | 'itemId'`.
 */
export type PathParams<TPath extends string> = TPath extends `${string}:${infer Rest}`
  ? Rest extends `${infer Param}/${infer Tail}`
    ? Param | PathParams<`/${Tail}`>
    : Rest
  : never;

/** Typed view of a path's parameters: every value is a string. */
export type ParamsOf<TPath extends string> = Readonly<Record<PathParams<TPath>, string>>;

/**
 * The minimal schema surface the engine needs: `parse` decodes what comes
 * in (query, body), `encode` turns what goes out (output, SSE events) into
 * its wire form — so a zod codec (say ISO string <-> `Date`) works in both
 * directions. Every zod schema satisfies it structurally, which lets
 * mixed-generic contracts live in one array without variance fights.
 * Values MUST be zod schemas — `toOpenApi` converts them via
 * `z.toJSONSchema`.
 */
export type SchemaLike = {
  parse(input: unknown): unknown;
  encode(value: unknown): unknown;
};

/**
 * A failure definition as a contract lists it: what `defineFailure` returns.
 * The client revives a listed failure with it (code + data schema); the
 * failure value itself carries the status and message the server answers with.
 */
export type FailureDefinitionLike = {
  readonly code: string;
  readonly dataSchema: StandardSchemaV1 | undefined;
  (...args: never[]): Failure;
};

/** The failure values a contract lists: `RouteFailure<typeof getPost>`. */
export type RouteFailure<TContract> =
  TContract extends RouteContract<string, unknown, unknown, unknown, infer TFailures>
    ? ReturnType<TFailures[number]>
    : never;

/**
 * A JSON route contract. Create via {@link route}. The generics carry the
 * validated input/output types into the bound handler's signature, and the
 * listed failures into what the handler may return and the client resolves to.
 */
export type RouteContract<
  TPath extends string = string,
  TQuery = undefined,
  TBody = undefined,
  TOutput = undefined,
  TFailures extends readonly FailureDefinitionLike[] = readonly [],
> = {
  readonly kind: 'http';
  /** Stable identifier — lands in the manifest and OpenAPI `operationId`. */
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: TPath;
  readonly summary?: string;
  readonly query?: z.ZodType<TQuery>;
  readonly body?: z.ZodType<TBody>;
  readonly output?: z.ZodType<TOutput>;
  /**
   * The failures the handler may return, as `defineFailure` definitions. A
   * returned failure answers with its status and the error envelope; the
   * client resolves to it instead of throwing.
   */
  readonly failures?: TFailures;
  toDotAction(): RouteMeta;
};

/**
 * A typed server-sent-events contract. Create via {@link route.sse}. The
 * bound handler is an async generator; every yielded value is validated
 * against `event` and framed as an SSE `data:` message.
 */
export type SseContract<TPath extends string = string, TQuery = undefined, TEvent = unknown> = {
  readonly kind: 'sse';
  readonly id: string;
  readonly method: 'GET';
  readonly path: TPath;
  readonly summary?: string;
  readonly query?: z.ZodType<TQuery>;
  /** Schema every yielded event is validated against. */
  readonly event: z.ZodType<TEvent>;
  /** Emit `:keepalive` comments at this interval. Off when omitted. */
  readonly heartbeatMs?: number;
  toDotAction(): RouteMeta;
};

/**
 * Generics-erased view of a contract — what bundles store and the engine,
 * manifest registration, and OpenAPI generation consume. Both contract
 * types are structurally assignable to it; no casts involved.
 */
export type ContractLike = {
  readonly kind: 'http' | 'sse';
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary?: string;
  readonly query?: SchemaLike;
  readonly body?: SchemaLike;
  readonly output?: SchemaLike;
  readonly failures?: readonly FailureDefinitionLike[];
  readonly event?: SchemaLike;
  readonly heartbeatMs?: number;
  toDotAction(): RouteMeta;
};

type RouteDef<TQuery, TBody, TOutput, TFailures> = {
  readonly id: string;
  readonly summary?: string;
  readonly query?: z.ZodType<TQuery>;
  readonly body?: z.ZodType<TBody>;
  readonly output?: z.ZodType<TOutput>;
  readonly failures?: TFailures;
};

const makeRoute =
  <TMethod extends HttpMethod>(method: TMethod) =>
  <
    TPath extends string,
    TQuery = undefined,
    TBody = undefined,
    TOutput = undefined,
    const TFailures extends readonly FailureDefinitionLike[] = readonly [],
  >(
    path: TPath,
    def: RouteDef<TQuery, TBody, TOutput, TFailures>,
  ): RouteContract<TPath, TQuery, TBody, TOutput, TFailures> => {
    const contract: RouteContract<TPath, TQuery, TBody, TOutput, TFailures> = {
      kind: 'http',
      method,
      path,
      ...def,
      toDotAction: () => contractMeta(contract),
    };
    return contract;
  };

/**
 * Contract factories, one per method, plus {@link route.sse} for typed
 * event streams.
 *
 * ```ts
 * export const listOrders = route.get('/orders', {
 *   id: 'orders.list',
 *   query: z.object({ status: z.enum(['open', 'shipped']).optional() }),
 *   output: z.array(Order),
 * });
 *
 * export const getOrder = route.get('/orders/:id', {
 *   id: 'orders.get',
 *   output: Order,
 *   failures: [OrderNotFound], // defineFailure definitions the handler may return
 * });
 *
 * export const progress = route.sse('/orders/:id/progress', {
 *   id: 'orders.progress',
 *   event: z.discriminatedUnion('type', [Queued, Shipped]),
 * });
 * ```
 */
export const route = {
  get: makeRoute('GET'),
  post: makeRoute('POST'),
  put: makeRoute('PUT'),
  patch: makeRoute('PATCH'),
  delete: makeRoute('DELETE'),
  sse: <TPath extends string, TEvent, TQuery = undefined>(
    path: TPath,
    def: {
      readonly id: string;
      readonly summary?: string;
      readonly query?: z.ZodType<TQuery>;
      readonly event: z.ZodType<TEvent>;
      readonly heartbeatMs?: number;
    },
  ): SseContract<TPath, TQuery, TEvent> => {
    const contract: SseContract<TPath, TQuery, TEvent> = {
      kind: 'sse',
      method: 'GET',
      path,
      ...def,
      toDotAction: () => contractMeta(contract),
    };
    return contract;
  },
};
