/**
 * OpenAPI generation — falls out of the contracts, doesn't bolt on.
 *
 * Contracts are static data carrying zod schemas, so the document is
 * produced without booting anything, deterministically: same contracts in
 * the same order → byte-identical output (DOT principle 3). No decorator
 * reconstruction, no annotations — the schema IS the validation IS the
 * documentation.
 */

import { z } from 'zod';

import type { ContractLike, SchemaLike } from './contract.js';
import { HTTP_ERROR_CODES, HttpConfigError } from './error.js';
import { openApiPaths, pathPlaceholders } from './path.js';
import { isRawOutput } from './raw.js';

export type OpenApiInfo = {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const HTTP_ACTION_META_SCHEMA = '@arki/http/action-meta@1';

/**
 * Convert a contract schema to JSON Schema. Schema erasure seam:
 * {@link ContractLike} types schemas as `parse`/`encode` only, but contracts
 * built via `route.*` always hold zod schemas (see `SchemaLike` docs) — the
 * cast re-attaches what the erased view dropped.
 *
 * `io: 'input'` describes the wire form: every schema here either decodes
 * what arrives or encodes what leaves, and a codec's wire side is its input.
 */
function toJsonSchema(schema: SchemaLike): JsonObject {
  const json = z.toJSONSchema(schema as z.ZodType, { io: 'input' }) as Record<string, unknown>;
  // The dialect header is noise when embedding into OpenAPI 3.1.
  const { $schema: _dialect, ...rest } = json;
  return toJsonObject(rest);
}

function toJsonObject(value: unknown): JsonObject {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('Value must be JSON-serializable manifest data.', { cause: error });
  }
  if (serialized === undefined) throw new TypeError('Value must be a JSON-serializable object.');
  const parsed = JSON.parse(serialized) as unknown;
  if (!isJsonObject(parsed) || !jsonDeepEqual(value, parsed)) {
    throw new TypeError('Value must be a JSON-serializable object without lossy coercions.');
  }
  return parsed;
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

/** Replace `#/$defs/X` references with the definitions they name; a reference to itself becomes `{}`. */
function inlineRefs(value: JsonValue, defs: JsonObject, seen: readonly string[]): JsonValue {
  if (Array.isArray(value)) return value.map(item => inlineRefs(item, defs, seen));
  if (typeof value !== 'object' || value === null) return value;
  const ref = value['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const name = ref.slice('#/$defs/'.length);
    const target = defs[name];
    if (target === undefined || seen.includes(name)) return {};
    return inlineRefs(target, defs, [...seen, name]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineRefs(item, defs, seen)]));
}

/**
 * The properties of an object schema, ready to stand alone as parameters.
 * A property that points into the root's `$defs` would dangle once lifted
 * out of it, so those references are inlined.
 */
function propertiesOf(json: JsonObject): { readonly properties: JsonObject; readonly required: ReadonlySet<string> } {
  const defs = isJsonObject(json['$defs']) ? json['$defs'] : {};
  const properties = isJsonObject(json['properties']) ? json['properties'] : {};
  const required = Array.isArray(json['required'])
    ? new Set(json['required'].filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  const lifted: JsonObject = {};
  for (const [name, schema] of Object.entries(properties)) lifted[name] = inlineRefs(schema, defs, []);
  return { properties: lifted, required };
}

function parametersFromSchemaObject(location: 'query' | 'header', json: JsonObject): JsonObject[] {
  const { properties, required } = propertiesOf(json);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: location,
    required: required.has(name),
    schema,
  }));
}

function buildResponses(action: HttpActionForProjection): JsonObject {
  if (action.streaming === true) {
    return {
      '200': {
        description: 'event stream',
        content: { 'text/event-stream': action.output === undefined ? {} : { schema: action.output } },
      },
    };
  }
  const responses: JsonObject = {};
  // A raw route documents its body only; the engine never checks it.
  const contentType = action.raw === undefined ? 'application/json' : (action.raw.contentType ?? '*/*');
  if (action.raw === undefined) {
    if (action.output === undefined) {
      responses['204'] = { description: 'no content' };
    } else {
      responses['200'] = { description: 'success', content: { 'application/json': { schema: action.output } } };
    }
  } else {
    responses['200'] = { description: 'success', content: { [contentType]: {} } };
  }
  for (const [status, schema] of Object.entries(action.responses ?? {})) {
    responses[status] = {
      description: Number(status) < 400 ? 'success' : 'error',
      content: { [contentType]: { schema } },
    };
  }
  return responses;
}

/** One operation, for one concrete path of the route (`omitted` is the optional placeholder this variant leaves out). */
function buildOperation(action: HttpActionForProjection, omitted: string | undefined): JsonObject {
  const parameters: JsonObject[] = pathPlaceholders(action.path)
    .filter(({ name }) => name !== omitted)
    .map(({ name }) => ({
      name,
      in: 'path',
      required: true,
      schema: action.input?.params === undefined ? { type: 'string' } : (propertiesOf(action.input.params).properties[name] ?? { type: 'string' }),
    }));
  if (action.input?.query !== undefined) parameters.push(...parametersFromSchemaObject('query', action.input.query));
  if (action.input?.headers !== undefined) parameters.push(...parametersFromSchemaObject('header', action.input.headers));

  const operation: JsonObject = {
    operationId: omitted === undefined ? action.id : `${action.id}.without-${omitted}`,
  };
  if (action.plugin !== undefined) operation['tags'] = [action.plugin];
  if (action.summary !== undefined) operation['summary'] = action.summary;
  if (parameters.length > 0) operation['parameters'] = parameters;
  if (action.input?.body !== undefined) {
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: action.input.body } },
    };
  }
  operation['responses'] = buildResponses(action);
  if (action.raw !== undefined) operation['x-arki-raw'] = true;
  return operation;
}

/**
 * Paths and operations in action order. Duplicate method+path pairs fail
 * loudly with `ARKI_HTTP_E002`, optional-placeholder variants included.
 */
function renderPaths(actions: Iterable<HttpActionForProjection>, collidesWith: 'contract' | 'action'): Record<string, JsonObject> {
  const paths: Record<string, JsonObject> = {};
  for (const action of actions) {
    const method = action.method.toLowerCase();
    for (const { path, omitted } of openApiPaths(action.path)) {
      const entry = (paths[path] ??= {});
      if (entry[method] !== undefined) {
        throw new HttpConfigError({
          code: HTTP_ERROR_CODES.duplicateRoute,
          message: `[http] duplicate route ${action.method} ${action.path}: "${action.id}" collides with an earlier ${collidesWith}.`,
          remediation: `Two ${collidesWith}s claim the same method and path. Change one path, or drop the duplicate.`,
        });
      }
      entry[method] = buildOperation(action, omitted);
    }
  }
  return paths;
}

/**
 * Render an OpenAPI 3.1 document from contracts. Paths and operations
 * appear in contract order; duplicate method+path pairs fail loudly with
 * `ARKI_HTTP_E002` (the same collision `buildEngine` rejects at boot).
 */
export function toOpenApi(contracts: readonly ContractLike[], info: OpenApiInfo): JsonObject {
  const actions = contracts.map(contract => {
    const { id, summary, meta } = contractMeta(contract);
    return httpActionFromMeta({ id, plugin: undefined, summary, meta });
  });
  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    paths: renderPaths(actions, 'contract'),
  };
}

type DotActionLike = {
  readonly id: string;
  readonly plugin: string;
  readonly binding: string;
  readonly direction: 'in' | 'out';
  readonly address?: string;
  readonly summary?: string;
  readonly meta?: JsonObject;
  readonly metaSchema?: string;
};

type DotManifestLike = {
  readonly app: { readonly name: string; readonly version?: string };
  readonly actions: readonly DotActionLike[];
};

type HttpActionForProjection = {
  readonly id: string;
  /** The owning plugin; absent when rendering contracts directly, so no `tags`. */
  readonly plugin: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
  readonly input?: {
    readonly params?: JsonObject;
    readonly query?: JsonObject;
    readonly headers?: JsonObject;
    readonly body?: JsonObject;
  };
  readonly output?: JsonObject;
  readonly raw?: { readonly contentType?: string };
  readonly responses?: Readonly<Record<string, JsonObject>>;
  readonly streaming?: boolean;
};

/** The DOT action declaration derived from a contract. */
export type RouteMeta = {
  readonly id: string;
  readonly binding: 'http';
  readonly direction: 'in';
  readonly address: string;
  readonly summary?: string;
  readonly metaSchema: typeof HTTP_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

/**
 * Manifest metadata for a contract — what contract `toDotAction()` returns
 * for DOT plugins and what `registerRoutes` feeds into `ctx.registerAction`
 * during the shim window. SSE contracts mark `streaming` and carry the
 * per-event schema as `output`. A `raw()` route carries `raw` instead of
 * `output`, and `responses` holds one JSON Schema per declared status.
 */
export function contractMeta(contract: ContractLike): RouteMeta {
  const input: JsonObject = {};
  if (contract.params !== undefined) input['params'] = toJsonSchema(contract.params);
  if (contract.query !== undefined) input['query'] = toJsonSchema(contract.query);
  if (contract.headers !== undefined) input['headers'] = toJsonSchema(contract.headers);
  if (contract.body !== undefined) input['body'] = toJsonSchema(contract.body);

  const meta: JsonObject = {
    method: contract.method,
    path: contract.path,
  };
  if (Object.keys(input).length > 0) meta['input'] = input;
  if (contract.kind === 'sse') {
    if (contract.event !== undefined) meta['output'] = toJsonSchema(contract.event);
    meta['streaming'] = true;
  } else if (isRawOutput(contract.output)) {
    meta['raw'] = contract.output.contentType === undefined ? {} : { contentType: contract.output.contentType };
  } else if (contract.output !== undefined) {
    meta['output'] = toJsonSchema(contract.output);
  }
  if (contract.responses !== undefined && Object.keys(contract.responses).length > 0) {
    const responses: JsonObject = {};
    for (const [status, schema] of Object.entries(contract.responses)) responses[status] = toJsonSchema(schema);
    meta['responses'] = responses;
  }

  return {
    id: contract.id,
    binding: 'http',
    direction: 'in',
    address: `${contract.method} ${contract.path}`,
    ...(contract.summary === undefined ? {} : { summary: contract.summary }),
    metaSchema: HTTP_ACTION_META_SCHEMA,
    meta,
  };
}

/** Read an action's metadata back into the shape the renderer takes. */
function httpActionFromMeta(action: {
  readonly id: string;
  readonly plugin: string | undefined;
  readonly summary?: string;
  readonly meta?: JsonObject;
}): HttpActionForProjection {
  const meta = action.meta;
  if (meta === undefined) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" has no HTTP metadata.`,
      remediation: 'Register HTTP actions through route contracts or registerRoute during the migration window.',
    });
  }
  const method = meta['method'];
  const path = meta['path'];
  if (typeof method !== 'string' || typeof path !== 'string') {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" is missing string method/path metadata.`,
      remediation: 'HTTP action meta must include string `method` and `path` fields.',
    });
  }

  const inputValue = meta['input'];
  const outputValue = meta['output'];
  const streamingValue = meta['streaming'];
  const rawValue = meta['raw'];
  const responsesValue = meta['responses'];
  const input = isJsonObject(inputValue)
    ? {
        ...(isJsonObject(inputValue['params']) ? { params: inputValue['params'] } : {}),
        ...(isJsonObject(inputValue['query']) ? { query: inputValue['query'] } : {}),
        ...(isJsonObject(inputValue['headers']) ? { headers: inputValue['headers'] } : {}),
        ...(isJsonObject(inputValue['body']) ? { body: inputValue['body'] } : {}),
      }
    : undefined;
  const contentType = isJsonObject(rawValue) ? rawValue['contentType'] : undefined;
  const responses: Record<string, JsonObject> = {};
  if (isJsonObject(responsesValue)) {
    for (const [status, schema] of Object.entries(responsesValue)) {
      if (isJsonObject(schema)) responses[status] = schema;
    }
  }

  return {
    id: action.id,
    plugin: action.plugin,
    method,
    path,
    ...(action.summary === undefined ? {} : { summary: action.summary }),
    ...(input === undefined || Object.keys(input).length === 0 ? {} : { input }),
    ...(isJsonObject(outputValue) ? { output: outputValue } : {}),
    ...(isJsonObject(rawValue) ? { raw: typeof contentType === 'string' ? { contentType } : {} } : {}),
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
    ...(typeof streamingValue === 'boolean' ? { streaming: streamingValue } : {}),
  };
}

function httpActionFromManifestAction(action: DotActionLike): HttpActionForProjection | null {
  if (action.binding !== 'http') return null;
  if (action.metaSchema !== undefined && action.metaSchema !== HTTP_ACTION_META_SCHEMA) {
    throw new HttpConfigError({
      code: HTTP_ERROR_CODES.invalidActionMeta,
      message: `[http] action "${action.id}" uses unsupported meta schema "${action.metaSchema}".`,
      remediation: `HTTP projections require ${HTTP_ACTION_META_SCHEMA}; omit metaSchema only for legacy registerRoute shim output during the DOT 0.4 migration window.`,
    });
  }
  return httpActionFromMeta(action);
}

export function toOpenApiFromManifest(manifest: DotManifestLike): JsonObject {
  const actions = manifest.actions
    .map(action => httpActionFromManifestAction(action))
    .filter((action): action is HttpActionForProjection => action !== null);
  return {
    openapi: '3.1.0',
    info: {
      title: manifest.app.name,
      version: manifest.app.version ?? '0.0.0',
    },
    paths: renderPaths(actions, 'action'),
  };
}
