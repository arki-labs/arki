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

import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';

import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import type { RouteMeta } from './openapi.js';
import { contractMeta } from './openapi.js';
import { pathPlaceholders } from './path.js';
import type { RawOutput } from './raw.js';
import { isRawOutput } from './raw.js';

/** Methods a {@link RouteContract} can declare. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Placeholder names as written: `'/a/:id/:slug?'` → `'id' | 'slug?'`. */
type RawParams<TPath extends string> = TPath extends `${string}:${infer Rest}`
  ? Rest extends `${infer Param}/${infer Tail}`
    ? Param | RawParams<`/${Tail}`>
    : Rest
  : never;

/**
 * Path-parameter names extracted from a path literal at the type level:
 * `'/orders/:id/items/:itemId'` → `'id' | 'itemId'`. An optional
 * placeholder (`:itemId?`) counts under its plain name.
 */
export type PathParams<TPath extends string> = RawParams<TPath> extends infer P extends string
  ? P extends `${infer Name}?`
    ? Name
    : P
  : never;

type OptionalParams<TPath extends string> = RawParams<TPath> extends infer P extends string
  ? P extends `${infer Name}?`
    ? Name
    : never
  : never;

/** Typed view of a path's parameters: every value is a string, an optional one may be missing. */
export type ParamsOf<TPath extends string> = Readonly<
  Record<Exclude<PathParams<TPath>, OptionalParams<TPath>>, string> & Partial<Record<OptionalParams<TPath>, string>>
>;

/**
 * The minimal schema surface the engine needs: `parse` decodes what comes
 * in (params, headers, query, body), `encode` turns what goes out (output,
 * `responses`, SSE events) into its wire form — so a zod codec (say ISO
 * string <-> `Date`) works in both directions. Every zod schema satisfies
 * it structurally, which lets mixed-generic contracts live in one array
 * without variance fights. Values MUST be zod schemas — `toOpenApi` converts
 * them via `z.toJSONSchema`.
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
export type RouteFailure<TContract> = TContract extends {
  readonly failures: infer TFailures extends readonly FailureDefinitionLike[];
}
  ? ReturnType<TFailures[number]>
  : never;

/**
 * Status code to body schema, for the statuses a handler may answer with
 * `reply(status, body)`. Integer keys 200-599. Never 204 or 304 (they carry
 * no body: a route without `output` answers 204), and never 200 next to a
 * schema `output`. On a `raw()` route the schemas only document.
 */
export type ResponseSchemas = Readonly<Record<number, z.ZodType>>;

/** A zod object whose keys are the lower-case header names the route reads. */
export type HeaderSchema = z.ZodType & { readonly shape: Readonly<Record<string, z.ZodType>> };

/** A zod object with one key per path placeholder. A missing key fails to compile; an extra key throws at declaration. */
export type ParamSchema<TPath extends string> = z.ZodType & {
  readonly shape: Readonly<Record<PathParams<TPath>, z.ZodType>>;
};

/** What a JSON route declares. The generic `TDef` of {@link RouteContract} is the literal def. */
export type RouteDef<TPath extends string> = {
  /** Stable identifier — lands in the manifest and OpenAPI `operationId`. */
  readonly id: string;
  readonly summary?: string;
  readonly params?: ParamSchema<TPath>;
  readonly query?: z.ZodType;
  readonly headers?: HeaderSchema;
  readonly body?: z.ZodType;
  /**
   * The success body. A schema: the handler returns its output type, sent as
   * 200 JSON. `raw()`: the handler returns a `Response`. Absent: the handler
   * returns nothing and the route answers 204.
   */
  readonly output?: z.ZodType | RawOutput;
  readonly responses?: ResponseSchemas;
  /**
   * The failures the handler may return, as `defineFailure` definitions. A
   * returned failure answers with its status and the error envelope; the
   * client resolves to it instead of throwing.
   */
  readonly failures?: readonly FailureDefinitionLike[];
};

/**
 * A JSON route contract. Create via {@link route}. `TDef` is the literal
 * def, so the bound handler's input and result types, and the client's, are
 * read straight from the declared schemas.
 */
export type RouteContract<TPath extends string = string, TDef extends RouteDef<TPath> = RouteDef<TPath>> = TDef & {
  readonly kind: 'http';
  readonly method: HttpMethod;
  readonly path: TPath;
  toDotAction(): RouteMeta;
};

/** What a typed SSE route declares. */
export type SseDef<TPath extends string> = Pick<RouteDef<TPath>, 'id' | 'summary' | 'params' | 'query' | 'headers'> & {
  /** Schema every yielded event is validated against. */
  readonly event: z.ZodType;
  /** Emit `:keepalive` comments at this interval. Off when omitted. */
  readonly heartbeatMs?: number;
};

/**
 * A typed server-sent-events contract. Create via {@link route.sse}. The
 * bound handler is an async generator; every yielded value is validated
 * against `event` and framed as an SSE `data:` message.
 */
export type SseContract<TPath extends string = string, TDef extends SseDef<TPath> = SseDef<TPath>> = TDef & {
  readonly kind: 'sse';
  readonly method: 'GET';
  readonly path: TPath;
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
  readonly params?: SchemaLike;
  readonly query?: SchemaLike;
  readonly headers?: SchemaLike;
  readonly body?: SchemaLike;
  readonly output?: SchemaLike | RawOutput;
  readonly responses?: Readonly<Record<number, SchemaLike>>;
  readonly failures?: readonly FailureDefinitionLike[];
  readonly event?: SchemaLike;
  readonly heartbeatMs?: number;
  toDotAction(): RouteMeta;
};

function isShape(value: unknown): value is Readonly<Record<string, z.ZodType>> {
  return typeof value === 'object' && value !== null;
}

/** The fields of a zod object schema, or `undefined` for any other schema. */
export function shapeOf(schema: unknown): Readonly<Record<string, z.ZodType>> | undefined {
  if (typeof schema !== 'object' || schema === null || !('shape' in schema)) return undefined;
  return isShape(schema.shape) ? schema.shape : undefined;
}

type ContractParts = {
  readonly id: string;
  readonly params?: unknown;
  readonly headers?: unknown;
  readonly output?: unknown;
  readonly responses?: unknown;
};

/** What an optional placeholder's schema must accept: the value of a segment that was left out. */
const missing: unknown = undefined;

function invalid(id: string, problem: string, remediation: string): never {
  throw new HttpConfigError({
    code: HTTP_ERROR_CODES.invalidContract,
    message: `[http] route "${id}" is invalid: ${problem}`,
    remediation,
  });
}

/**
 * Declaration-time checks. A contract that cannot work fails here, with the
 * contract id and the bad key, instead of on the first request.
 */
function assertContract(path: string, def: ContractParts): void {
  const placeholders = pathPlaceholders(path);
  const optional = placeholders.filter(placeholder => placeholder.optional);
  if (optional.length > 1 || (optional[0] !== undefined && !path.endsWith(`:${optional[0].name}?`))) {
    invalid(
      def.id,
      `path "${path}" has an optional placeholder that is not the only, last segment.`,
      'The router supports one optional placeholder, as the last segment: "/orders/:id?".',
    );
  }

  if (def.params !== undefined) {
    const shape = shapeOf(def.params);
    if (shape === undefined) {
      invalid(def.id, 'params must be a z.object.', 'Declare params as z.object({ <placeholder>: schema }).');
    }
    const names = new Set(placeholders.map(placeholder => placeholder.name));
    for (const name of names) {
      if (!(name in shape)) {
        invalid(def.id, `params has no key for the placeholder ":${name}".`, `Add "${name}" to params.`);
      }
    }
    for (const key of Object.keys(shape)) {
      if (!names.has(key)) {
        invalid(
          def.id,
          `params key "${key}" is not a placeholder of "${path}".`,
          'Remove the key, or add the placeholder to the path.',
        );
      }
    }
    for (const placeholder of optional) {
      if (!shape[placeholder.name]?.safeParse(missing).success) {
        invalid(
          def.id,
          `params key "${placeholder.name}" is optional in the path but its schema rejects a missing value.`,
          'Make the schema optional: z.string().optional().',
        );
      }
    }
  }

  if (def.headers !== undefined) {
    const shape = shapeOf(def.headers);
    if (shape === undefined) {
      invalid(def.id, 'headers must be a z.object.', 'Declare headers as z.object({ "x-name": schema }).');
    }
    for (const key of Object.keys(shape)) {
      if (key !== key.toLowerCase()) {
        invalid(
          def.id,
          `header key "${key}" is not lower-case.`,
          `Use "${key.toLowerCase()}": the Fetch API lower-cases every header name.`,
        );
      }
    }
  }

  if (def.responses !== undefined && typeof def.responses === 'object' && def.responses !== null) {
    for (const key of Object.keys(def.responses)) {
      const status = Number(key);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        invalid(def.id, `responses key "${key}" is not a status from 200 to 599.`, 'Use integer status codes.');
      }
      if (status === 204 || status === 304) {
        invalid(
          def.id,
          `responses cannot declare ${status}: it has no body.`,
          status === 204
            ? 'Leave out "output" and return nothing to answer 204.'
            : 'Return a Response from a route declared with output: raw().',
        );
      }
      if (status === 200 && def.output !== undefined && !isRawOutput(def.output)) {
        invalid(def.id, 'responses declares 200 next to output.', 'Declare the 200 body once, as "output".');
      }
    }
  }
}

const makeRoute =
  <TMethod extends HttpMethod>(method: TMethod) =>
  <TPath extends string, TDef extends RouteDef<TPath>>(path: TPath, def: TDef): RouteContract<TPath, TDef> => {
    assertContract(path, def);
    const contract: RouteContract<TPath, TDef> = {
      ...def,
      kind: 'http',
      method,
      path,
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
 *   params: z.object({ id: OrderId }),
 *   headers: z.object({ 'x-tenant': z.string() }),
 *   output: Order,
 *   responses: { 409: Conflict }, // handler: return reply(409, { ... })
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
  sse: <TPath extends string, TDef extends SseDef<TPath>>(path: TPath, def: TDef): SseContract<TPath, TDef> => {
    assertContract(path, def);
    const contract: SseContract<TPath, TDef> = {
      ...def,
      kind: 'sse',
      method: 'GET',
      path,
      toDotAction: () => contractMeta(contract),
    };
    return contract;
  },
};
